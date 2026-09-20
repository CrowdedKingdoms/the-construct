/**
 * The Construct's starter Crowdy Studio projects.
 *
 * Each is a tiny, deployable Rust module a player can open from the Studio's
 * Common Files, read in one sitting, deploy, and see do something. The seed
 * publishes their `src/lib.rs` into the app's immutable common-file catalog
 * (`crowdyStudioCommonPublish`), where import is copy-by-value, so a later
 * seed never edits a player's project behind their back.
 *
 * Plain ES module: shared by the browser wizard and `scripts/seed.mjs`.
 */

const SDK_VERSION = '0.1.5';

function cargo(name, extraDeps = '', tickIntervalMs = null) {
  const tick =
    tickIntervalMs == null
      ? ''
      : `
# How often the browser calls CLIENT on_tick (clamped 16–1000 ms).
# 1000 = HUD/text. 50 = physics minigames (pool). 16 = shooters, if a tick stays cheap.
[package.metadata.crowdy]
tick_interval_ms = ${tickIntervalMs}
`;
  return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
${tick}
[dependencies]
crowdy-compute-sdk = "${SDK_VERSION}"
${extraDeps}`;
}

const SERDE_JSON_DEP = 'serde_json = "1"\n';

/**
 * CLIENT: runs in the visitor's browser sandbox. Asks the host for its own
 * grid bounds (`grid_info`, answered locally by the broker), lists the actors
 * standing in the grid's first chunk (`actors_list`, routed to the game's
 * allowlisted host-call router) and renders a greeting through `hud_set`.
 * Presentation crosses as data; the game renders it as text, never HTML.
 */
const HUD_GREETER = `use crowdy_compute_sdk::{api, host_call};
use serde_json::json;

fn grid_origin() -> Option<(i64, i64, i64)> {
    let info = host_call("grid_info", json!({})).ok()?;
    let low = info.get("low")?;
    let parse = |v: &serde_json::Value| v.as_str()?.parse::<i64>().ok();
    Some((parse(low.get("x")?)?, parse(low.get("y")?)?, parse(low.get("z")?)?))
}

fn on_init() {}

fn on_tick(_dt: u32) {
    let Some((x, y, z)) = grid_origin() else { return };
    let actors = api::actors_list(x, y, z).unwrap_or_else(|_| json!({ "actors": [] }));
    let rows = actors.get("actors").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let names: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .filter(|n| !n.is_empty())
        .collect();
    let greeting = if names.is_empty() {
        "Nobody here yet.".to_string()
    } else {
        format!("Welcome, {}!", names.join(", "))
    };
    // The host owns the HUD; this payload is rendered as text.
    let _ = host_call(
        "hud_set",
        json!({ "payload": { "greeting": greeting, "here": rows.len(), "chunk": [x, y, z] } }),
    );
    // Mouse: crowdy::api::pointer_clicks() each tick. Drain {clicks, buttons,
    // holdingMs}. Click-to-charge = left down, holdingMs["0"] while held, fire on up.
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/**
 * CLIENT: plants one voxel in the middle of the owned grid so visitors see a
 * real block in the holodeck, not only HUD text. `voxel_set` replicates
 * through the chunk store (same path as Paint).
 */
const VOXEL_MARKER = `use crowdy_compute_sdk::host_call;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

static PLACED: AtomicBool = AtomicBool::new(false);

fn grid_origin() -> Option<(i64, i64, i64)> {
    let info = host_call("grid_info", json!({})).ok()?;
    let low = info.get("low")?;
    let parse = |v: &serde_json::Value| v.as_str()?.parse::<i64>().ok();
    Some((parse(low.get("x")?)?, parse(low.get("y")?)?, parse(low.get("z")?)?))
}

fn on_init() {}

fn on_tick(_dt: u32) {
    if PLACED.load(Ordering::Relaxed) {
        return;
    }
    let Some((x, y, z)) = grid_origin() else { return };
    let result = host_call(
        "voxel_set",
        json!({
            "chunkX": x,
            "chunkY": y,
            "chunkZ": z,
            "x": 8,
            "y": 1,
            "z": 8,
            "voxelType": 1
        }),
    );
    if result.is_ok() {
        PLACED.store(true, Ordering::Relaxed);
    }
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/**
 * SERVER: runs in the platform scheduler as the grid owner, only while the
 * app has players. Counts the actors in the grid each tick and answers an
 * invoke with the latest count as JSON — the smallest possible "server
 * authority" a client (or a CLIENT mod) can ask for.
 */
const BEACON = `use crowdy_compute_sdk::api;
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

static LAST_COUNT: AtomicU32 = AtomicU32::new(0);

fn on_init() {}

fn on_tick(_dt: u32) {
    // The grid this module is bound to: chunk coordinates come from your claim.
    // Replace with your grid's low corner, or read it from a model property.
    let (x, y, z) = (0i64, 0i64, 0i64);
    let actors = api::actors_list(x, y, z).unwrap_or_else(|_| json!({ "actors": [] }));
    let count = actors.get("actors").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
    LAST_COUNT.store(count as u32, Ordering::Relaxed);
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> {
    json!({ "present": LAST_COUNT.load(Ordering::Relaxed) }).to_string().into_bytes()
}

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/** Shared SERVER wire for construct.scene.v1 (catalog chunks + packed poses). */
const SCENE_WIRE = `const EVENT_CATALOG: u16 = 0xC501;
const EVENT_POSES: u16 = 0xC502;
const SOURCE: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = u32::from_be_bytes([0, b[0], b[1], b[2]]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn emit_state(event: u16, chunk: (i64, i64, i64), state: &[u8]) {
    if 2 + state.len() > 1024 {
        return;
    }
    let mut p = Vec::with_capacity(2 + state.len());
    p.extend_from_slice(&event.to_le_bytes());
    p.extend_from_slice(state);
    let _ = api::emit_spatial("server_event", chunk, SOURCE, &b64(&p), 2, 0);
}

fn emit_catalog(rev: u32, json: &str, chunk: (i64, i64, i64)) {
    let bytes = json.as_bytes();
    let max = 1014usize;
    let parts = ((bytes.len() + max - 1) / max).max(1).min(255) as u8;
    for part in 0..parts {
        let start = part as usize * max;
        let end = (start + max).min(bytes.len());
        let slice = &bytes[start..end];
        let mut pkt = vec![0u8; 8 + slice.len()];
        pkt[0..4].copy_from_slice(&rev.to_le_bytes());
        pkt[4] = part;
        pkt[5] = parts;
        pkt[6..8].copy_from_slice(&(slice.len() as u16).to_le_bytes());
        pkt[8..].copy_from_slice(slice);
        emit_state(EVENT_CATALOG, chunk, &pkt);
    }
}

struct Pose {
    x: f32,
    y: f32,
    z: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    qw: f32,
    sx: f32,
    sy: f32,
    sz: f32,
}

fn quat_i16(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0) as i16
}

fn scale_u8(v: f32) -> u8 {
    let t = ((v.clamp(0.04, 8.0) - 0.04) / 7.96).clamp(0.0, 1.0);
    (t * 255.0).round() as u8
}

fn emit_poses(rev: u32, chunk: (i64, i64, i64), poses: &[Pose]) {
    let mut pkt = Vec::with_capacity(5 + poses.len() * 24);
    pkt.extend_from_slice(&rev.to_le_bytes());
    pkt.push(poses.len() as u8);
    for (i, p) in poses.iter().enumerate() {
        pkt.push(i as u8);
        pkt.extend_from_slice(&p.x.to_le_bytes());
        pkt.extend_from_slice(&p.y.to_le_bytes());
        pkt.extend_from_slice(&p.z.to_le_bytes());
        pkt.extend_from_slice(&quat_i16(p.qx).to_le_bytes());
        pkt.extend_from_slice(&quat_i16(p.qy).to_le_bytes());
        pkt.extend_from_slice(&quat_i16(p.qz).to_le_bytes());
        pkt.extend_from_slice(&quat_i16(p.qw).to_le_bytes());
        pkt.push(scale_u8(p.sx));
        pkt.push(scale_u8(p.sy));
        pkt.push(scale_u8(p.sz));
    }
    emit_state(EVENT_POSES, chunk, &pkt);
}
`;

/**
 * SERVER: a parent box and a child that spins on a quaternion. Every visitor
 * on the grid sees it — they do not have to run a CLIENT companion.
 */
const SPINNING_CHILD = `use crowdy_compute_sdk::api;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

${SCENE_WIRE}

static LAST_CATALOG_MS: AtomicU64 = AtomicU64::new(0);
const CHUNK: (i64, i64, i64) = (0, 0, 0);
const REV: u32 = 1;

fn catalog_json() -> String {
    json!({
        "v": 1,
        "revision": REV,
        "meshes": [],
        "nodes": [
            {"id":"root","kind":"box","x":8.0,"y":1.0,"z":8.0,"sx":0.8,"sy":0.8,"sz":0.8,"color":2132556},
            {"id":"arm","parent":"root","kind":"box","x":0.7,"y":0.2,"z":0.0,"sx":0.2,"sy":0.2,"sz":0.8,"color":16755200}
        ]
    })
    .to_string()
}

fn maybe_catalog() {
    let now = crowdy_compute_sdk::now_ms();
    let last = LAST_CATALOG_MS.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 3000 {
        return;
    }
    LAST_CATALOG_MS.store(now, Ordering::Relaxed);
    emit_catalog(REV, &catalog_json(), CHUNK);
}

fn on_init() {}

fn on_tick(_dt: u32) {
    maybe_catalog();
    let t = (crowdy_compute_sdk::now_ms() as f32) / 1000.0;
    let (s, c) = (t.sin(), t.cos());
    emit_poses(REV, CHUNK, &[
        Pose { x: 8.0, y: 1.0, z: 8.0, qx: 0.0, qy: s, qz: 0.0, qw: c, sx: 0.8, sy: 0.8, sz: 0.8 },
        Pose { x: 0.7, y: 0.2, z: 0.0, qx: 0.0, qy: 0.0, qz: 0.0, qw: 1.0, sx: 0.2, sy: 0.2, sz: 0.8 },
    ]);
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/**
 * SERVER: a felt table, three balls, and a procedural-mesh cue whose handle
 * quaternion spins. Visitors who never accepted CLIENT still see it.
 */
const POOL_CUE = `use crowdy_compute_sdk::api;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

${SCENE_WIRE}

static LAST_CATALOG_MS: AtomicU64 = AtomicU64::new(0);
const CHUNK: (i64, i64, i64) = (0, 0, 0);
const REV: u32 = 1;

fn cue_mesh() -> serde_json::Value {
    let (hx, hy, hz) = (0.03_f64, 0.03_f64, 0.7_f64);
    let positions = [
        -hx, -hy, -hz,  hx, -hy, -hz,  hx,  hy, -hz, -hx,  hy, -hz,
        -hx, -hy,  hz,  hx, -hy,  hz,  hx,  hy,  hz, -hx,  hy,  hz,
    ];
    let indices = [
        0,1,2, 0,2,3, 4,6,5, 4,7,6,
        0,4,5, 0,5,1, 3,2,6, 3,6,7,
        0,3,7, 0,7,4, 1,5,6, 1,6,2,
    ];
    json!({
        "id": "cue-mesh",
        "kind": "mesh",
        "color": 13932973,
        "positions": positions,
        "indices": indices
    })
}

fn catalog_json() -> String {
    json!({
        "v": 1,
        "revision": REV,
        "meshes": [cue_mesh()],
        "nodes": [
            {"id":"felt","kind":"box","x":8.0,"y":0.78,"z":8.0,"sx":2.2,"sy":0.12,"sz":1.2,"color":1336939},
            {"id":"ball-1","kind":"sphere","x":7.4,"y":0.92,"z":7.7,"sx":0.08,"sy":0.08,"sz":0.08,"color":16316664},
            {"id":"ball-2","kind":"sphere","x":7.6,"y":0.92,"z":8.0,"sx":0.08,"sy":0.08,"sz":0.08,"color":13369344},
            {"id":"ball-3","kind":"sphere","x":7.4,"y":0.92,"z":8.3,"sx":0.08,"sy":0.08,"sz":0.08,"color":220},
            {"id":"cue","mesh":"cue-mesh","kind":"mesh","x":8.6,"y":1.05,"z":8.0,"sx":1.0,"sy":1.0,"sz":1.0,"color":13932973}
        ]
    })
    .to_string()
}

fn maybe_catalog() {
    let now = crowdy_compute_sdk::now_ms();
    let last = LAST_CATALOG_MS.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 3000 {
        return;
    }
    LAST_CATALOG_MS.store(now, Ordering::Relaxed);
    emit_catalog(REV, &catalog_json(), CHUNK);
}

fn on_init() {}

fn on_tick(_dt: u32) {
    maybe_catalog();
    let t = (crowdy_compute_sdk::now_ms() as f32) / 1400.0;
    let (s, c) = ((t * 0.5).sin(), (t * 0.5).cos());
    emit_poses(REV, CHUNK, &[
        Pose { x: 8.0, y: 0.78, z: 8.0, qx: 0.0, qy: 0.0, qz: 0.0, qw: 1.0, sx: 2.2, sy: 0.12, sz: 1.2 },
        Pose { x: 7.4, y: 0.92, z: 7.7, qx: 0.0, qy: 0.0, qz: 0.0, qw: 1.0, sx: 0.08, sy: 0.08, sz: 0.08 },
        Pose { x: 7.6, y: 0.92, z: 8.0, qx: 0.0, qy: 0.0, qz: 0.0, qw: 1.0, sx: 0.08, sy: 0.08, sz: 0.08 },
        Pose { x: 7.4, y: 0.92, z: 8.3, qx: 0.0, qy: 0.0, qz: 0.0, qw: 1.0, sx: 0.08, sy: 0.08, sz: 0.08 },
        Pose { x: 8.6, y: 1.05, z: 8.0, qx: 0.0, qy: s, qz: 0.25 * t.sin(), qw: c, sx: 1.0, sy: 1.0, sz: 1.0 },
    ]);
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/** @type {import('./index.d.mts').StarterTemplate[]} */
export const STARTER_TEMPLATES = [
  {
    id: 'construct-hud-greeter',
    title: 'HUD greeter',
    target: 'CLIENT',
    description:
      'A browser mod that reads who is standing in your grid and greets them in the mod HUD. ' +
      'Start here for CLIENT mods.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-hud-greeter', SERDE_JSON_DEP, 1000) },
      { path: 'src/lib.rs', content: HUD_GREETER },
    ],
  },
  {
    id: 'construct-beacon',
    title: 'Presence beacon',
    target: 'SERVER',
    description:
      'A server module that counts actors in your grid each tick and answers an invoke with the count. ' +
      'Start here for SERVER mods.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-beacon', SERDE_JSON_DEP) },
      { path: 'src/lib.rs', content: BEACON },
    ],
  },
  {
    id: 'construct-voxel-marker',
    title: 'Voxel marker',
    target: 'CLIENT',
    description:
      'Places one voxel in the centre of your grid. Other players see the block in the holodeck ' +
      'because it writes the shared chunk store, not a private HUD.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-voxel-marker', SERDE_JSON_DEP, 1000) },
      { path: 'src/lib.rs', content: VOXEL_MARKER },
    ],
  },
  {
    id: 'construct-spinning-child',
    title: 'Spinning child',
    target: 'SERVER',
    description:
      'A parent box and a child that spin on a quaternion. Every visitor on the grid sees it — ' +
      'they do not have to trust or run a CLIENT companion. Replace CHUNK with your claim.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-spinning-child', SERDE_JSON_DEP) },
      { path: 'src/lib.rs', content: SPINNING_CHILD },
    ],
  },
  {
    id: 'construct-pool-cue',
    title: 'Pool cue',
    target: 'SERVER',
    description:
      'A felt table, three balls, and a procedural-mesh cue animated with quaternions. ' +
      'Passersby who never accepted CLIENT still see the same scene.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-pool-cue', SERDE_JSON_DEP) },
      { path: 'src/lib.rs', content: POOL_CUE },
    ],
  },
];

/**
 * The common-file form of a template, ready for `crowdyStudioCommonPublish`.
 *
 * Two entries per template: the entrypoint AND its Cargo.toml. The Studio's
 * blank project declares only `crowdy-compute-sdk`, and `host_call` takes a
 * `serde_json::Value`, so any template that builds JSON needs the `serde_json`
 * dependency declared — measured on 2026-09-07 as `E0432: unresolved import
 * serde_json` when only the entrypoint was imported. Players add both files;
 * each import defaults to the right destination path.
 */
export function commonFilesFor(template) {
  const entrypoint = template.files.find((file) => file.path === 'src/lib.rs');
  const cargo = template.files.find((file) => file.path === 'Cargo.toml');
  if (!entrypoint || !cargo) throw new Error(`${template.id} needs src/lib.rs and Cargo.toml`);
  const tags = ['crowdy-studio', 'the-construct', template.target.toLowerCase(), 'starter'];
  return [
    {
      slug: template.id,
      title: `${template.title} entrypoint`,
      description:
        `${template.description} Add this src/lib.rs AND the matching "${template.title} Cargo.toml" ` +
        `to a ${template.target} project, then Test draft.`,
      path: 'src/lib.rs',
      target: template.target,
      tags,
      content: entrypoint.content,
    },
    {
      slug: `${template.id}-cargo`,
      title: `${template.title} Cargo.toml`,
      description: `Cargo.toml for "${template.title}": declares serde_json beside the compute SDK.`,
      path: 'Cargo.toml',
      target: template.target,
      tags: [...tags, 'cargo'],
      content: cargo.content,
    },
  ];
}

/** Back-compat alias: the entrypoint entry only. */
export function commonFileFor(template) {
  return commonFilesFor(template)[0];
}
