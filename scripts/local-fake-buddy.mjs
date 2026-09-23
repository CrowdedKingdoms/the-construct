#!/usr/bin/env node
/**
 * Local-dev stand-in for Buddy.
 *
 * - UDP client + peer sockets + server_status / Redis occupancy heartbeats so
 *   ck-api can place the Construct UDP proxy.
 * - Reframes P2P_SPATIAL_INJECT (23) into client spatial downlinks.
 * - Injects ACTOR_UPDATE_NOTIFICATION (130) for fake players whose pose we
 *   control over HTTP on :8787 (WASD pad + JSON API).
 *
 * Does not implement the real Buddy handshake; nest's proxy treats any inbound
 * datagram as liveness, which these actor ticks provide.
 */
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BUDDY_ID = '00000000-0000-4000-8000-00000000e2e1';
const APP_ID = process.env.FAKE_BUDDY_APP_ID || '91156204474368';
const CONTROL_PORT = Number(process.env.FAKE_BUDDY_CONTROL_PORT || 8787);
const CHUNK_SIZE = 16;
const ENV_PATH = '/home/ubuntu/cks-project-root/cks-game-api/.env';
const ACTOR_OPCODE = 130;
const TICK_MS = 200;
const WALK_SPEED = 4;

function envMap() {
  const out = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function hostPrimaryIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        return iface.address;
      }
    }
  }
  throw new Error('no non-loopback IPv4');
}

function psql(sql, paramsEnv) {
  const r = spawnSync(
    'psql',
    [
      '-h',
      'localhost',
      '-U',
      paramsEnv.DB_USERNAME,
      '-d',
      paramsEnv.DB_DATABASE,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { env: { ...process.env, PGPASSWORD: paramsEnv.DB_PASSWORD }, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || 'psql failed\n');
    throw new Error(`psql exit ${r.status}`);
  }
  return r.stdout;
}

function redis(...args) {
  const r = spawnSync('redis-cli', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`redis-cli ${args.join(' ')}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function padUuid(id) {
  const raw = Buffer.from(String(id), 'utf8').subarray(0, 32);
  const out = Buffer.alloc(32, 0);
  raw.copy(out);
  return out;
}

function encodeName(name) {
  const out = Buffer.alloc(24, 0);
  const encoded = Buffer.from(String(name ?? ''), 'utf8').subarray(0, 24);
  encoded.copy(out);
  return out;
}

function worldToChunk(n) {
  return BigInt(Math.floor(n / CHUNK_SIZE));
}

/** Construct poseCodec: 64 little-endian bytes. */
function encodePose(player) {
  const buf = Buffer.alloc(64);
  buf.writeFloatLE(player.x, 0);
  buf.writeFloatLE(player.y, 4);
  buf.writeFloatLE(player.z, 8);
  buf.writeFloatLE(player.yaw, 12);
  buf.writeFloatLE(player.pitch, 16);
  buf.writeFloatLE(player.vx, 20);
  buf.writeFloatLE(player.vy, 24);
  buf.writeFloatLE(player.vz, 28);
  const moving = player.vx !== 0 || player.vz !== 0;
  buf.writeUInt8(moving ? 1 : 0, 32);
  buf.writeUInt8(player.program & 0xff, 33);
  buf.writeUInt8(player.tint & 0xff, 34);
  encodeName(player.name).copy(buf, 36);
  return buf;
}

function actorNotification(player, seq) {
  const payload = encodePose(player);
  const header = Buffer.alloc(68);
  header.writeUInt8(ACTOR_OPCODE, 0);
  header.writeBigUInt64LE(BigInt(APP_ID), 1);
  header.writeBigInt64LE(worldToChunk(player.x), 9);
  header.writeBigInt64LE(worldToChunk(player.y), 17);
  header.writeBigInt64LE(worldToChunk(player.z), 25);
  header.writeUInt8(4, 33); // distance
  header.writeUInt8(0, 34); // decay none
  header.writeUInt8(0, 35); // containsAuth = 0
  padUuid(player.id).copy(header, 36);
  const trailer = Buffer.alloc(9);
  trailer.writeBigInt64LE(BigInt(Date.now()), 0);
  trailer.writeUInt8(seq & 0xff, 8);
  return Buffer.concat([header, payload, trailer]);
}

function reframeSpatialInject(msg, seq) {
  if (msg.length < 70 + 32 || msg[0] !== 23) return null;
  const emitOpcode = msg[1];
  const payloadLen = msg.readUInt16LE(68);
  if (payloadLen < 0 || 70 + payloadLen + 32 > msg.length) return null;
  const payload = msg.subarray(70, 70 + payloadLen);
  const header = Buffer.alloc(68);
  header.writeUInt8(emitOpcode, 0);
  msg.copy(header, 1, 2, 34);
  header.writeUInt8(msg[34], 33);
  header.writeUInt8(msg[35], 34);
  header.writeUInt8(0, 35);
  msg.copy(header, 36, 36, 68);
  const trailer = Buffer.alloc(9);
  trailer.writeBigInt64LE(BigInt(Date.now()), 0);
  trailer.writeUInt8(seq & 0xff, 8);
  return Buffer.concat([header, payload, trailer]);
}

function makePlayer(partial) {
  return {
    id: 'fake0000000000000000000000000001',
    name: 'FakeBot',
    x: -8,
    y: 1.6,
    z: -8,
    yaw: 0,
    pitch: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    program: 0,
    tint: 3,
    keys: { w: false, a: false, s: false, d: false },
    patrol: null,
    flight: null,
    homeFlight: null,
    poppedUntil: 0,
    ...partial,
  };
}

const CONTROL_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Fake Buddy players</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; background:#111; color:#eee; margin:24px; }
  kbd { background:#333; padding:2px 6px; border-radius:4px; }
  button, input { font: inherit; }
  pre { background:#1c1c1c; padding:12px; overflow:auto; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; }
</style>
<h1>Fake Buddy players</h1>
<p>Focus this page and use <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to walk the selected bot around the claimed pool chunk (−16..0 on X/Z).</p>
<div class="row">
  <label>Pilot <select id="pilot"></select></label>
  <button id="add">Add player</button>
  <button id="patrol">Toggle patrol</button>
</div>
<pre id="out">loading…</pre>
<script>
const keys = { w:false, a:false, s:false, d:false };
const out = document.getElementById('out');
const sel = document.getElementById('pilot');
async function refresh() {
  const r = await fetch('/players');
  const data = await r.json();
  const current = sel.value;
  sel.innerHTML = data.players.map(p => '<option value="'+p.id+'">'+p.name+' ('+p.id.slice(0,8)+')</option>').join('');
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
  out.textContent = JSON.stringify(data, null, 2);
}
async function sendKeys() {
  if (!sel.value) return;
  await fetch('/players/' + encodeURIComponent(sel.value) + '/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(keys),
  });
}
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) { keys[k] = true; e.preventDefault(); sendKeys(); }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) { keys[k] = false; e.preventDefault(); sendKeys(); }
});
document.getElementById('add').onclick = async () => {
  await fetch('/players', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  refresh();
};
document.getElementById('patrol').onclick = async () => {
  if (!sel.value) return;
  await fetch('/players/' + encodeURIComponent(sel.value) + '/patrol', { method: 'POST' });
  refresh();
};
setInterval(refresh, 400);
refresh();
</script>
`;

const env = envMap();
const ip = hostPrimaryIp();
const peer = dgram.createSocket('udp4');
const client = dgram.createSocket('udp4');
const clients = new Map();
const players = new Map();

let injects = 0;
let forwarded = 0;
let seq = 0;
let ticks = 0;

function orbitFlight(partial) {
  return {
    cx: -8,
    cz: -8,
    radius: 3.2,
    y: 5,
    speed: 0.7,
    phase: 0,
    ...partial,
  };
}

const aliceFlight = orbitFlight({ radius: 3.1, y: 4.6, speed: 0.85, phase: 0.4 });
const bobFlight = orbitFlight({ radius: 4.4, y: 7.2, speed: -0.62, phase: 2.1 });

players.set(
  'fake0000000000000000000000000001',
  makePlayer({
    id: 'fake0000000000000000000000000001',
    name: 'Alice',
    x: aliceFlight.cx + Math.cos(aliceFlight.phase) * aliceFlight.radius,
    y: aliceFlight.y,
    z: aliceFlight.cz + Math.sin(aliceFlight.phase) * aliceFlight.radius,
    tint: 4,
    flight: aliceFlight,
    homeFlight: aliceFlight,
  }),
);
players.set(
  'fake0000000000000000000000000002',
  makePlayer({
    id: 'fake0000000000000000000000000002',
    name: 'Bob',
    x: bobFlight.cx + Math.cos(bobFlight.phase) * bobFlight.radius,
    y: bobFlight.y,
    z: bobFlight.cz + Math.sin(bobFlight.phase) * bobFlight.radius,
    tint: 7,
    flight: bobFlight,
    homeFlight: bobFlight,
  }),
);

function rememberClient(rinfo) {
  clients.set(`${rinfo.address}:${rinfo.port}`, rinfo);
}

function fanout(buf) {
  for (const rinfo of clients.values()) {
    client.send(buf, rinfo.port, rinfo.address, () => {});
    forwarded += 1;
  }
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    y: p.y,
    vx: p.vx,
    vz: p.vz,
    flying: Boolean(p.flight),
    popped: p.poppedUntil > Date.now(),
    program: p.program,
    tint: p.tint,
    patrol: Boolean(p.patrol),
    keys: p.keys,
  };
}

function ejectPlayer(p) {
  p.flight = null;
  p.patrol = null;
  p.keys = { w: false, a: false, s: false, d: false };
  p.x = p.name === 'Bob' ? 12 : 8;
  p.y = 0;
  p.z = p.name === 'Bob' ? 6 : 10;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.yaw = 0;
  p.pitch = 0;
  p.poppedUntil = Date.now() + 8000;
}

function stepFlight(p, dt) {
  const flight = p.flight;
  flight.phase += flight.speed * dt;
  const x = flight.cx + Math.cos(flight.phase) * flight.radius;
  const z = flight.cz + Math.sin(flight.phase) * flight.radius;
  const y = flight.y + Math.sin(flight.phase * 2) * 0.7;
  p.vx = (x - p.x) / dt;
  p.vy = (y - p.y) / dt;
  p.vz = (z - p.z) / dt;
  p.x = x;
  p.y = y;
  p.z = z;
  const horiz = Math.hypot(p.vx, p.vz) || 1;
  // Holodeck yaw 0 looks down -Z: forward is (-sin yaw, -cos yaw).
  p.yaw = Math.atan2(-p.vx, -p.vz);
  p.pitch = Math.atan2(p.vy, horiz);
}

function stepPlayer(p, dt) {
  if (p.poppedUntil) {
    if (Date.now() < p.poppedUntil) {
      p.vx = 0;
      p.vy = 0;
      p.vz = 0;
      return;
    }
    p.poppedUntil = 0;
    p.flight = p.homeFlight;
    if (p.flight) {
      p.x = p.flight.cx;
      p.y = p.flight.y;
      p.z = p.flight.cz;
    }
  }
  if (p.flight) {
    stepFlight(p, dt);
    return;
  }
  let wishX = 0;
  let wishZ = 0;
  if (p.keys.w) wishZ -= 1;
  if (p.keys.s) wishZ += 1;
  if (p.keys.a) wishX -= 1;
  if (p.keys.d) wishX += 1;
  if (wishX || wishZ) {
    const len = Math.hypot(wishX, wishZ) || 1;
    p.vx = (wishX / len) * WALK_SPEED;
    p.vz = (wishZ / len) * WALK_SPEED;
    p.yaw = Math.atan2(p.vx, p.vz);
    p.patrol = null;
  } else if (p.patrol) {
    p.patrol.t += p.patrol.dir * dt * 0.25;
    if (p.patrol.t > 1) {
      p.patrol.t = 1;
      p.patrol.dir = -1;
    }
    if (p.patrol.t < 0) {
      p.patrol.t = 0;
      p.patrol.dir = 1;
    }
    const nx = p.patrol.ax + (p.patrol.bx - p.patrol.ax) * p.patrol.t;
    const nz = p.patrol.az + (p.patrol.bz - p.patrol.az) * p.patrol.t;
    p.vx = (nx - p.x) / dt;
    p.vz = (nz - p.z) / dt;
    p.x = nx;
    p.z = nz;
    p.yaw = Math.atan2(p.vx, p.vz);
    return;
  } else {
    p.vx = 0;
    p.vz = 0;
  }
  p.x += p.vx * dt;
  p.z += p.vz * dt;
}

peer.on('message', (msg) => {
  const framed = reframeSpatialInject(msg, seq++);
  if (!framed) return;
  injects += 1;
  fanout(framed);
  if (injects <= 3 || injects % 50 === 0) {
    console.log(
      JSON.stringify({
        injects,
        forwarded,
        clients: clients.size,
        opcode: msg[1],
        bytes: framed.length,
      }),
    );
  }
});
client.on('message', (_msg, rinfo) => rememberClient(rinfo));

await new Promise((res) => peer.bind(0, '0.0.0.0', res));
await new Promise((res) => client.bind(0, '0.0.0.0', res));
const peerPort = peer.address().port;
const clientPort = client.address().port;

psql(
  `
UPDATE datacenter_endpoints
   SET game_api_url = 'http://localhost:5175',
       game_api_ws_url = 'ws://localhost:5175',
       updated_at = now()
 WHERE datacenter_code = 'or';

UPDATE app_placements
   SET datacenter_code = 'or',
       game_api_url = 'http://localhost:5175',
       game_api_ws_url = 'ws://localhost:5175',
       updated_at = now()
 WHERE app_id = ${APP_ID};
`,
  env,
);

function heartbeat() {
  const now = Date.now();
  psql(
    `
INSERT INTO server_status
  (buddy_instance_id, public_ip4, public_ip6, ip4, ip6, client_port, peer_port,
   status, clients, datacenter_code, drain_requested, updated_at)
VALUES ('${BUDDY_ID}', '${ip}', '::1', '${ip}', '::1', ${clientPort}, ${peerPort},
        'ReadyForClients', ${clients.size}, 'or', false, now())
ON CONFLICT (buddy_instance_id) DO UPDATE SET
  public_ip4 = EXCLUDED.public_ip4,
  ip4 = EXCLUDED.ip4,
  client_port = EXCLUDED.client_port,
  peer_port = EXCLUDED.peer_port,
  status = 'ReadyForClients',
  clients = EXCLUDED.clients,
  datacenter_code = 'or',
  drain_requested = false,
  updated_at = now();
`,
    env,
  );
  redis(
    'HSET',
    `occ:b:${BUDDY_ID}`,
    'slots',
    '8',
    'active',
    String(Math.max(1, clients.size)),
    'router_threads',
    '1',
    'status',
    'ReadyForClients',
    'version',
    '1',
    'updated_ms',
    String(now),
  );
  redis('HSET', `occ:a:${APP_ID}`, BUDDY_ID, String(Math.max(1, clients.size)));
  redis('ZADD', 'occ:z:buddies', String(now), BUDDY_ID);
  upsertPresence(now);
}

const SELF_UUID = process.env.FAKE_BUDDY_SELF_UUID || 'f99077f2fa389ad9deeded60ecaca042';
const SELF_USER_ID = process.env.FAKE_BUDDY_SELF_USER_ID || '91156204056576';

function upsertPresence(now) {
  const records = [
    { uuid: SELF_UUID, userId: SELF_USER_ID, x: -8, y: 1.6, z: -8 },
    ...[...players.values()].map((p) => ({
      uuid: p.id,
      userId: SELF_USER_ID,
      x: p.x,
      y: p.y,
      z: p.z,
    })),
  ];
  for (const rec of records) {
    const packed = [
      rec.userId,
      worldToChunk(rec.x).toString(),
      worldToChunk(rec.y).toString(),
      worldToChunk(rec.z).toString(),
      String(now),
      String(now),
      String(now),
    ].join('\t');
    redis('HSET', `presence:h:${APP_ID}`, rec.uuid, packed);
    redis('ZADD', `presence:z:${APP_ID}`, String(now), rec.uuid);
  }
}

heartbeat();
setInterval(() => {
  try {
    heartbeat();
  } catch (err) {
    console.error('heartbeat', err.message);
  }
}, 5000);

setInterval(() => {
  const dt = TICK_MS / 1000;
  ticks += 1;
  for (const p of players.values()) {
    stepPlayer(p, dt);
    fanout(actorNotification(p, seq++));
  }
}, TICK_MS);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(data);
}

function nextPlayerId() {
  let n = players.size + 1;
  while (true) {
    const id = `fake${String(n).padStart(28, '0')}`;
    if (!players.has(id)) return id;
    n += 1;
  }
}

const control = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CONTROL_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      json(res, 200, {
        ok: true,
        ip,
        clientPort,
        peerPort,
        buddyId: BUDDY_ID,
        appId: APP_ID,
        clients: clients.size,
        players: players.size,
        ticks,
        forwarded,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/players') {
      json(res, 200, { players: [...players.values()].map(publicPlayer) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/players') {
      const body = await readBody(req);
      const id = padUuid(body.id || nextPlayerId()).toString('utf8').replace(/\0/g, '');
      const p = makePlayer({
        id,
        name: body.name || `Bot${players.size + 1}`,
        x: Number.isFinite(body.x) ? body.x : -8,
        y: Number.isFinite(body.y) ? body.y : 1.6,
        z: Number.isFinite(body.z) ? body.z : -8,
        tint: Number.isFinite(body.tint) ? body.tint : (players.size % 8) + 1,
      });
      players.set(id, p);
      json(res, 200, publicPlayer(p));
      return;
    }
    const keysMatch = url.pathname.match(/^\/players\/([^/]+)\/keys$/);
    if (req.method === 'POST' && keysMatch) {
      const p = players.get(decodeURIComponent(keysMatch[1]));
      if (!p) return json(res, 404, { error: 'unknown player' });
      const body = await readBody(req);
      p.keys = {
        w: Boolean(body.w),
        a: Boolean(body.a),
        s: Boolean(body.s),
        d: Boolean(body.d),
      };
      json(res, 200, publicPlayer(p));
      return;
    }
    const ejectMatch = url.pathname.match(/^\/players\/([^/]+)\/eject$/);
    if (req.method === 'POST' && ejectMatch) {
      const p = players.get(decodeURIComponent(ejectMatch[1]));
      if (!p) return json(res, 404, { error: 'unknown player' });
      ejectPlayer(p);
      json(res, 200, publicPlayer(p));
      return;
    }
    const patrolMatch = url.pathname.match(/^\/players\/([^/]+)\/patrol$/);
    if (req.method === 'POST' && patrolMatch) {
      const p = players.get(decodeURIComponent(patrolMatch[1]));
      if (!p) return json(res, 404, { error: 'unknown player' });
      p.patrol = p.patrol
        ? null
        : { ax: p.x - 3, az: p.z - 3, bx: p.x + 3, bz: p.z + 3, t: 0, dir: 1 };
      json(res, 200, publicPlayer(p));
      return;
    }
    const poseMatch = url.pathname.match(/^\/players\/([^/]+)$/);
    if (poseMatch && (req.method === 'PATCH' || req.method === 'POST')) {
      const p = players.get(decodeURIComponent(poseMatch[1]));
      if (!p) return json(res, 404, { error: 'unknown player' });
      const body = await readBody(req);
      for (const key of ['name', 'x', 'y', 'z', 'yaw', 'pitch', 'vx', 'vz', 'program', 'tint']) {
        if (body[key] !== undefined) p[key] = body[key];
      }
      json(res, 200, publicPlayer(p));
      return;
    }
    if (poseMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(poseMatch[1]);
      players.delete(id);
      json(res, 200, { ok: true, id });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 400, { error: String(err.message || err) });
  }
});

await new Promise((res) => control.listen(CONTROL_PORT, '0.0.0.0', res));

console.log(
  JSON.stringify({
    ok: true,
    ip,
    clientPort,
    peerPort,
    control: `http://127.0.0.1:${CONTROL_PORT}/`,
    buddyId: BUDDY_ID,
    appId: APP_ID,
    players: [...players.keys()],
  }),
);
