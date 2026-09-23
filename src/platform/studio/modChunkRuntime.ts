/**
 * Chunk-mod state the holodeck draws and the page broker answers.
 * The guest never receives the session. Calls arrive already allowlisted.
 */
import type { CrowdyClient } from '@crowdedkingdoms/crowdyjs';
import type { PlayerCodeGridBounds, PlayerCodeHostCall } from '@crowdedkingdoms/crowdyjs';

import type { Input } from '@/engine/Input';
import type { Pose } from '@/platform/realtime/actorCodec';
import { worldToChunk } from '@/platform/realtime/space';

export interface ModAppearance {
  color: number;
}

export interface ModPoseHold {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  atMs: number;
}

export interface ModProjectile {
  id: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  speed: number;
  startMs: number;
  lifeMs: number;
}

export interface ModOwnedActor {
  uuid: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface ModSessionPort {
  client: CrowdyClient;
  appId: string;
  gridId: string;
  selfUuid: string;
  userId: string;
  moveTo(chunk: { x: number; y: number; z: number }): Promise<void>;
  players(): Array<{ uuid: string; pose: { x: number; y: number; z: number } }>;
  voiceStart(): Promise<void>;
  voiceStop(): void;
  videoStart(): Promise<void>;
  videoStop(): void;
}

const inbox: unknown[] = [];
let appearance: ModAppearance | null = null;
let grid: PlayerCodeGridBounds | null = null;
let hold: ModPoseHold | null = null;
let input: Input | null = null;
let port: ModSessionPort | null = null;
let nextProjectile = 1;
const projectiles: ModProjectile[] = [];
const owned = new Map<string, ModOwnedActor>();
let avatarSnapshot: string | null = null;
let avatarId: string | null = null;
let subscribed = false;

export function bindModGrid(bounds: PlayerCodeGridBounds): void {
  grid = bounds;
}

export function bindModInput(next: Input | null): void {
  input = next;
}

export function bindModSession(next: ModSessionPort | null): void {
  port = next;
  if (next && !subscribed && typeof next.client.udp.subscribe === 'function') {
    subscribed = true;
    next.client.udp.subscribe(
      {
        clientEvent: (event) => remember(event),
        text: (event) => remember(event),
        actorUpdate: (event) => remember(event),
        voxelUpdate: (event) => remember(event),
      },
      next.appId,
    );
  }
}

export function releaseModChunk(): void {
  appearance = null;
  hold = null;
  projectiles.length = 0;
  owned.clear();
  inbox.length = 0;
  void restoreAvatar();
}

export function modAppearance(): ModAppearance | null {
  return appearance;
}

export function modHoldsLocomotion(): boolean {
  return hold !== null;
}

export function modPoseHold(): ModPoseHold | null {
  return hold;
}

export function modProjectiles(nowMs: number): ModProjectile[] {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const shot = projectiles[i]!;
    const t = (nowMs - shot.startMs) / 1000;
    if (t * shot.speed > shot.lifeMs / 1000 * shot.speed || nowMs - shot.startMs > shot.lifeMs) {
      projectiles.splice(i, 1);
    }
  }
  return projectiles;
}

export function modOwnedActors(): ModOwnedActor[] {
  return [...owned.values()];
}

export function chunkInModGrid(x: number, y: number, z: number): boolean {
  if (!grid) return false;
  const cx = BigInt(x);
  const cy = BigInt(y);
  const cz = BigInt(z);
  return (
    cx >= grid.low.x &&
    cx <= grid.high.x &&
    cy >= grid.low.y &&
    cy <= grid.high.y &&
    cz >= grid.low.z &&
    cz <= grid.high.z
  );
}

export function positionInModGrid(x: number, y: number, z: number): boolean {
  const chunk = worldToChunk({ x, y, z });
  return chunkInModGrid(chunk.x, chunk.y, chunk.z);
}

/** Integrate the last pose_set. The frame loop calls this while the mod holds the body. */
export function stepModPose(dt: number): ModPoseHold | null {
  if (!hold) return null;
  hold.x += hold.vx * dt;
  hold.y += hold.vy * dt;
  hold.z += hold.vz * dt;
  return hold;
}

export async function routeModGameplay(call: PlayerCodeHostCall): Promise<unknown> {
  const { fn, args } = call;
  switch (fn) {
    case 'input_axes':
      return input ? input.axes() : { x: 0, y: 0 };
    case 'input_look': {
      const delta = input?.takePointerDelta() ?? { dx: 0, dy: 0 };
      return { dx: delta.dx, dy: delta.dy };
    }
    case 'events_poll': {
      const batch = inbox.splice(0, inbox.length);
      return { events: batch };
    }
    case 'voice_set':
      if (!port) return { ok: false };
      if (args.action === 'stop') port.voiceStop();
      else await port.voiceStart();
      return { ok: true };
    case 'video_set':
      if (!port) return { ok: false };
      if (args.action === 'stop') port.videoStop();
      else await port.videoStart();
      return { ok: true };
    case 'avatar_appearance': {
      const color = Number(args.color ?? 0xff0000);
      appearance = { color: Number.isFinite(color) ? color : 0xff0000 };
      return { ok: true };
    }
    case 'pose_get':
      return hold ?? { held: false };
    case 'pose_release':
      hold = null;
      return { ok: true };
    case 'pose_set':
      return poseSet(args);
    case 'actor_spawn':
    case 'actor_pose':
      return actorPose(args, fn === 'actor_spawn');
    case 'actor_despawn':
      owned.delete(String(args.uuid ?? ''));
      return { ok: true };
    case 'send_client_event':
      return sendClientEvent(args);
    case 'send_text':
      return sendText(args);
    case 'send_actor_message':
      return sendActorMessage(args);
    case 'send_channel_message':
      return sendChannelMessage(args);
    case 'teleport_request':
      return teleport(args);
    case 'avatar_state_set':
      return avatarStateSet(args);
    default:
      return passSdk(fn, args);
  }
}

function poseSet(args: Record<string, unknown>): { ok: boolean; error?: string } {
  const x = num(args.x);
  const y = num(args.y);
  const z = num(args.z);
  if (!positionInModGrid(x, y, z)) return { ok: false, error: 'outside the player grid' };
  const chunk = worldToChunk({ x, y, z });
  const previous = hold ? worldToChunk({ x: hold.x, y: hold.y, z: hold.z }) : null;
  hold = {
    x,
    y,
    z,
    yaw: num(args.yaw),
    pitch: num(args.pitch),
    roll: num(args.roll),
    vx: num(args.vx),
    vy: num(args.vy),
    vz: num(args.vz),
    atMs: performance.now(),
  };
  if (
    !previous ||
    previous.x !== chunk.x ||
    previous.y !== chunk.y ||
    previous.z !== chunk.z
  ) {
    void port?.moveTo(chunk);
  }
  return { ok: true };
}

async function actorPose(args: Record<string, unknown>, spawn: boolean): Promise<unknown> {
  const uuid = String(args.uuid ?? '');
  if (!uuid || (port && uuid === port.selfUuid)) {
    return { ok: false, error: 'refusing a live player uuid' };
  }
  const x = num(args.x);
  const y = num(args.y);
  const z = num(args.z);
  if (!positionInModGrid(x, y, z) && !chunkInModGrid(num(args.chunkX), num(args.chunkY), num(args.chunkZ))) {
    return { ok: false, error: 'outside the player grid' };
  }
  const actor: ModOwnedActor = {
    uuid,
    x,
    y,
    z,
    yaw: num(args.yaw),
    pitch: num(args.pitch),
    roll: num(args.roll),
  };
  owned.set(uuid, actor);
  if (port) {
    const chunk = worldToChunk({ x, y, z });
    await port.client.udp.sendActorUpdate({
      appId: port.appId,
      chunk: { x: String(chunk.x), y: String(chunk.y), z: String(chunk.z) },
      uuid,
      state: '',
      distance: 8,
    });
  }
  return { ok: true, spawned: spawn, uuid };
}

async function sendClientEvent(args: Record<string, unknown>): Promise<unknown> {
  noteProjectile(args);
  if (!port) return { ok: false };
  const payload = String(args.payloadBase64 ?? '');
  await port.client.udp.sendClientEvent({
    appId: port.appId,
    chunk: { x: String(args.x), y: String(args.y), z: String(args.z) },
    uuid: port.selfUuid,
    eventType: Number(args.eventType ?? 1),
    state: payload,
    distance: 8,
  });
  return { ok: true };
}

async function sendText(args: Record<string, unknown>): Promise<unknown> {
  if (!port) return { ok: false };
  await port.client.udp.sendTextPacket({
    appId: port.appId,
    chunk: { x: String(args.x), y: String(args.y), z: String(args.z) },
    uuid: port.selfUuid,
    text: String(args.text ?? ''),
    distance: 8,
  });
  return { ok: true };
}

async function sendActorMessage(args: Record<string, unknown>): Promise<unknown> {
  if (!port) return { ok: false };
  const target = String(args.targetUuid ?? '');
  if (!actorInside(target)) return { ok: false, error: 'target is outside the grid' };
  await port.client.udp.sendSingleActorMessage({
    appId: port.appId,
    chunk: {
      x: String(args.targetChunkX),
      y: String(args.targetChunkY),
      z: String(args.targetChunkZ),
    },
    targetUuid: target,
    payload: String(args.payloadBase64 ?? ''),
  });
  return { ok: true };
}

async function sendChannelMessage(args: Record<string, unknown>): Promise<unknown> {
  if (!port) return { ok: false };
  await port.client.udp.sendChannelMessage({
    channelId: String(args.channelId ?? ''),
    uuid: port.selfUuid,
    payload: String(args.payloadBase64 ?? ''),
  });
  return { ok: true };
}

async function teleport(args: Record<string, unknown>): Promise<unknown> {
  if (!port) return { ok: false };
  const uuid = String(args.uuid ?? port.selfUuid);
  if (uuid !== port.selfUuid && !owned.has(uuid)) {
    return { ok: false, error: 'refusing another player uuid' };
  }
  if (
    !chunkInModGrid(num(args.destChunkX), num(args.destChunkY), num(args.destChunkZ))
  ) {
    return { ok: false, error: 'outside the player grid' };
  }
  const response = await port.client.teleport.request({
    appId: port.appId,
    chunkAddress: {
      x: String(args.destChunkX),
      y: String(args.destChunkY),
      z: String(args.destChunkZ),
    },
    voxelAddress: { x: 0, y: 0, z: 0 },
    uuid,
  });
  if (response.success && uuid === port.selfUuid) {
    const x = Number(args.destChunkX) * 16 + 8;
    const y = Number(args.destChunkY) * 16;
    const z = Number(args.destChunkZ) * 16 + 8;
    hold = {
      x,
      y,
      z,
      yaw: hold?.yaw ?? 0,
      pitch: hold?.pitch ?? 0,
      roll: hold?.roll ?? 0,
      vx: 0,
      vy: 0,
      vz: 0,
      atMs: performance.now(),
    };
    await port.moveTo({
      x: Number(args.destChunkX),
      y: Number(args.destChunkY),
      z: Number(args.destChunkZ),
    });
  }
  return response;
}

async function avatarStateSet(args: Record<string, unknown>): Promise<unknown> {
  if (!port) return { ok: false };
  const id = String(args.avatarId ?? '');
  if (!avatarId) {
    avatarId = id;
    const current = await port.client.avatars.appState(port.appId, id).catch(() => null);
    avatarSnapshot = current?.state ?? null;
  }
  await port.client.avatars.updateAppState({
    appId: port.appId,
    avatarId: id,
    state: String(args.stateBase64 ?? ''),
  });
  return { ok: true };
}

async function restoreAvatar(): Promise<void> {
  if (!port || !avatarId || avatarSnapshot == null) {
    avatarId = null;
    avatarSnapshot = null;
    return;
  }
  const id = avatarId;
  const state = avatarSnapshot;
  avatarId = null;
  avatarSnapshot = null;
  await port.client.avatars.updateAppState({ appId: port.appId, avatarId: id, state }).catch(() => undefined);
}

const PASS_SDK = new Set([
  'actors_create',
  'actors_update',
  'actors_delete',
  'actors_update_state',
  'chunk_update',
  'chunk_update_state',
  'chunk_lods',
  'voxels_history',
  'voxels_rollback',
  'channel_list',
  'channel_get',
  'channel_join',
  'channel_leave',
  'channel_create',
  'channel_update',
  'channel_remove',
  'channel_set_policy',
  'channel_members',
  'channel_add_member',
  'channel_remove_member',
  'channel_set_roles',
  'team_list',
  'team_get',
  'team_join',
  'team_leave',
  'team_create',
  'team_update',
  'team_remove',
  'team_set_policy',
  'inventory_ensure',
  'inventory_stacks',
  'inventory_grant',
  'inventory_consume',
  'inventory_move',
  'inventory_transfer',
  'inventory_craft',
  'inventory_barter',
  'session_create',
  'session_join',
  'session_turn',
  'model_traverse',
  'model_flow',
  'model_seed',
  'timer_schedule',
  'timer_cancel',
  'sessions_list',
  'container_get_batch',
  'edge_add',
  'edge_delete',
  'avatar_state_get',
  'player_containers_list',
  'player_container_create',
  'player_container_delete',
  'player_automations_list',
  'player_automation_create',
  'player_automation_set_enabled',
  'player_automation_delete',
  'server_module_invoke',
  'emit_channel',
  'emit_event',
]);

async function passSdk(fn: string, args: Record<string, unknown>): Promise<unknown> {
  if (!PASS_SDK.has(fn)) return { ok: false, error: `unrouted host call ${fn}` };
  if (!port) return { ok: false, error: 'no session' };
  const client = port.client;
  switch (fn) {
    case 'actors_create':
      return client.actors.create({ appId: port.appId, state: String(args.stateBase64 ?? '') } as never);
    case 'actors_update':
      return client.actors.update(String(args.uuid), { publicState: String(args.stateBase64 ?? '') } as never);
    case 'actors_delete':
      return client.actors.delete(String(args.uuid) as never);
    case 'actors_update_state':
      return client.actors.updateState(String(args.uuid) as never, String(args.stateBase64 ?? '') as never);
    case 'chunk_update':
      return client.chunks.update({ appId: port.appId, coordinates: coords(args), voxels: args.stateBase64 } as never);
    case 'chunk_update_state':
      return client.chunks.updateState({ appId: port.appId, coordinates: coords(args), chunkState: args.stateBase64 } as never);
    case 'chunk_lods':
      return client.chunks.getLods({ appId: port.appId, coordinates: coords(args) } as never);
    case 'voxels_history':
      return client.voxels.history({ appId: port.appId } as never);
    case 'voxels_rollback':
      return client.voxels.rollback({ appId: port.appId, voxelUpdateId: args.voxelUpdateId } as never);
    case 'channel_list':
      return client.channels.list(port.appId);
    case 'channel_get':
      return client.channels.get(String(args.id));
    case 'channel_join':
      return client.channels.join(String(args.id));
    case 'channel_leave':
      return client.channels.leave(String(args.id));
    case 'channel_create':
      return client.channels.create({ appId: port.appId, name: String(args.name ?? 'mod') } as never);
    case 'channel_update':
      return client.channels.update({ groupId: String(args.id), name: String(args.name ?? '') } as never);
    case 'channel_remove':
      return client.channels.remove(String(args.id));
    case 'channel_set_policy':
      return client.channels.setPolicy({ appId: port.appId, ...(args.policy as object) } as never);
    case 'channel_members':
      return client.channels.members(String(args.id));
    case 'channel_add_member':
      return client.channels.addMember(String(args.id), String(args.userId));
    case 'channel_remove_member':
      return client.channels.removeMember(String(args.id), String(args.userId));
    case 'channel_set_roles':
      return client.channels.setMemberRoles({
        groupId: String(args.id),
        userId: String(args.userId),
        roleIds: args.roles,
      } as never);
    case 'team_list':
      return client.teams.list(port.appId);
    case 'team_get':
      return client.teams.get(String(args.id));
    case 'team_join':
      return client.teams.join(String(args.id));
    case 'team_leave':
      return client.teams.leave(String(args.id));
    case 'team_create':
      return client.teams.create({ appId: port.appId, name: String(args.name ?? 'mod') } as never);
    case 'team_update':
      return client.teams.update({ groupId: String(args.id), name: String(args.name ?? '') } as never);
    case 'team_remove':
      return client.teams.remove(String(args.id));
    case 'team_set_policy':
      return client.teams.setPolicy({ appId: port.appId, ...(args.policy as object) } as never);
    case 'inventory_ensure':
      return client.kit(port.appId).inventory.ensure(port.userId);
    case 'inventory_stacks':
      return client.kit(port.appId).inventory.stacks(port.userId);
    case 'inventory_grant':
      return client.kit(port.appId).inventory.grant(String(args.stackId ?? args.itemId ?? ''), num(args.quantity) || 1);
    case 'inventory_consume':
      return client.kit(port.appId).inventory.consume(String(args.stackId ?? args.itemId ?? ''), num(args.quantity) || 1);
    case 'inventory_move':
      return client.kit(port.appId).inventory.move(String(args.stackId ?? args.itemId ?? ''), num(args.slot));
    case 'inventory_transfer':
      if (args.targetUuid != null && !actorInside(String(args.targetUuid))) {
        return { ok: false, error: 'target is outside the grid' };
      }
      return client.kit(port.appId).inventory.transfer(
        String(args.fromStackId ?? args.stackId ?? ''),
        String(args.toStackId ?? ''),
        num(args.quantity) || 1,
      );
    case 'inventory_craft':
      return client.kit(port.appId).inventory.craft(
        String(args.inventoryId ?? ''),
        String(args.recipeId ?? ''),
        Array.isArray(args.inputStackIds) ? args.inputStackIds.map(String) : [],
        String(args.outputStackId ?? ''),
      );
    case 'inventory_barter':
      if (args.targetUuid != null && !actorInside(String(args.targetUuid))) {
        return { ok: false, error: 'target is outside the grid' };
      }
      return client.kit(port.appId).inventory.barter(
        String(args.inventoryId ?? ''),
        String(args.barterId ?? args.recipeId ?? ''),
        String(args.payStackId ?? ''),
        String(args.receiveStackId ?? ''),
      );
    case 'session_create':
      return client.gameModel.createSession({ appId: port.appId, ...args } as never);
    case 'session_join':
      return client.gameModel.joinSession({ appId: port.appId, ...args } as never);
    case 'session_turn':
      return client.gameModel.setSessionTurn({ appId: port.appId, ...args } as never);
    case 'model_traverse':
      return client.gameModel.traverse({ appId: port.appId, ...args } as never);
    case 'model_flow':
      return client.gameModel.flow({ appId: port.appId, flowId: String(args.flowId ?? '') } as never);
    case 'model_seed':
      return client.gameModel.seed({ appId: port.appId, ...args } as never);
    case 'timer_schedule':
      return client.gameModel.scheduleInvoke({ appId: port.appId, ...args } as never);
    case 'timer_cancel':
      return client.gameModel.cancelTimer({ appId: port.appId, timerId: String(args.timerId ?? '') } as never);
    case 'sessions_list':
      return client.gameModel.sessions({ appId: port.appId } as never);
    case 'container_get_batch':
      return client.gameModel.containers({ appId: port.appId } as never);
    case 'edge_add':
      return client.gameModel.addEdge({ appId: port.appId, ...args } as never);
    case 'edge_delete':
      return client.gameModel.deleteEdge({ appId: port.appId, ...args } as never);
    case 'avatar_state_get':
      return client.avatars.appState(port.appId, String(args.avatarId ?? ''));
    case 'player_containers_list':
      return client.playerModel.containers({ appId: port.appId } as never);
    case 'player_container_create':
      return client.playerModel.createContainer({ appId: port.appId, ...args } as never);
    case 'player_container_delete':
      return client.playerModel.deleteContainer({
        appId: port.appId,
        containerId: String(args.containerId ?? args.id ?? ''),
      } as never);
    case 'player_automations_list':
      return client.playerModel.automations({ appId: port.appId } as never);
    case 'player_automation_create':
      return client.playerModel.createAutomation({ appId: port.appId, ...args } as never);
    case 'player_automation_set_enabled':
      return client.playerModel.setAutomationEnabled({
        appId: port.appId,
        automationId: String(args.automationId ?? args.id ?? ''),
        enabled: Boolean(args.enabled),
      } as never);
    case 'player_automation_delete':
      return client.playerModel.deleteAutomation({
        appId: port.appId,
        automationId: String(args.automationId ?? args.id ?? ''),
      } as never);
    case 'server_module_invoke': {
      const gridId = String(args.gridId ?? port.gridId);
      if (gridId !== port.gridId) return { ok: false, error: 'outside the player grid' };
      return client.playerCompute.invoke({
        appId: port.appId,
        gridId,
        moduleName: String(args.moduleName ?? ''),
        exportName: String(args.exportName ?? 'invoke'),
        paramsJson:
          typeof args.paramsJson === 'string' ? args.paramsJson : JSON.stringify(args.params ?? {}),
      });
    }
    case 'emit_channel':
    case 'emit_event':
      return client.playerCompute.invoke({
        appId: port.appId,
        gridId: port.gridId,
        moduleName: String(args.moduleName ?? ''),
        exportName: fn,
        paramsJson: JSON.stringify(args),
      });
    default:
      return { ok: false, error: `unrouted host call ${fn}` };
  }
}

function actorInside(uuid: string): boolean {
  if (!port) return false;
  if (owned.has(uuid)) return true;
  return port.players().some((player) => player.uuid === uuid && positionInModGrid(player.pose.x, player.pose.y, player.pose.z));
}

function noteProjectile(args: Record<string, unknown>): void {
  const raw = decodePayload(args.payloadBase64);
  if (!raw || raw.kind !== 'projectile') return;
  const origin = (raw.origin ?? {}) as Record<string, unknown>;
  const direction = (raw.direction ?? { z: -1 }) as Record<string, unknown>;
  projectiles.push({
    id: nextProjectile++,
    x: num(origin.x),
    y: num(origin.y ?? 1.7),
    z: num(origin.z),
    dx: num(direction.x),
    dy: num(direction.y),
    dz: num(direction.z ?? -1),
    speed: num(raw.speed ?? 40) || 40,
    startMs: num(raw.startMs) || performance.now(),
    lifeMs: num(raw.lifeMs ?? 2000) || 2000,
  });
}

function remember(event: unknown): void {
  inbox.push(event);
  if (inbox.length > 200) inbox.shift();
  if (event && typeof event === 'object' && 'state' in event) {
    noteProjectile({ payloadBase64: (event as { state?: string }).state });
  }
}

function decodePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const text = atob(value);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function coords(args: Record<string, unknown>) {
  return { x: String(args.x), y: String(args.y), z: String(args.z) };
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function poseFromHold(base: Pose): Pose {
  if (!hold) return base;
  return { ...base, ...hold, roll: hold.roll };
}
