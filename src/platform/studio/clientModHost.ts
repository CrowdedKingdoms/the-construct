/**
 * The host side of CLIENT mods: what a sandboxed player module may ask the
 * game for, and how a consented grid-attached mod is started for a visitor.
 *
 * The SDK's `PlayerCodeBroker` has already validated every call against the
 * platform allowlist, clamped chunk coordinates to the mod's grid AABB, rate-
 * limited it, and answered `grid_info` / `hud_set` / `overlay_draw` itself.
 * What reaches `routeClientHostCall` is world_read, `voxel_set`, and
 * `pointer_clicks`. Reads return only what the running player can already
 * lawfully see. Writes go through ChunkStore.setVoxel (optimistic + UDP),
 * markDirty (packed-chunk write-back), and GraphQL updateVoxel so SERVER
 * voxels_list can read mailbox JSON from voxel_updates. Never hand a mod
 * the raw client.
 */
import {
  PlayerCodeBroker,
  type CrowdyClient,
  type PlayerCodeGridBounds,
  type PlayerCodeHostCall,
  type PlayerCodePresentation,
} from '@crowdedkingdoms/crowdyjs';
import type { CrowdyStudioTextHud } from '@crowdedkingdoms/crowdyjs/crowdy-studio';
import type { ModOverlayStore } from '@/platform/studio/modOverlay';

export interface ClientVoxelState {
  x: number;
  y: number;
  z: number;
  state: string;
}

export interface ClientModHostReads {
  actorsInChunk(x: bigint, y: bigint, z: bigint): Array<Record<string, unknown>>;
  chunkVoxels(
    x: bigint,
    y: bigint,
    z: bigint,
  ):
    | { voxelsBase64: string | null; states?: ClientVoxelState[] }
    | null
    | Promise<{ voxelsBase64: string | null; states?: ClientVoxelState[] } | null>;
}

export interface ClientModHostWrites {
  setVoxel(input: {
    chunk: { x: number; y: number; z: number };
    x: number;
    y: number;
    z: number;
    voxelType: number;
    state?: string;
  }): Promise<boolean>;
}

export interface ClientModHostInput {
  drainPointerClicks(): unknown;
}

/** The host calls this game answers. Exported so the docs and tests agree. */
export const OFFERED_HOST_CALLS = [
  'actors_list',
  'actors_list_radius',
  'chunk_get',
  'voxels_list',
  'voxel_set',
  'pointer_clicks',
] as const;

/** One zero byte, base64: the smallest non-empty voxel state the API accepts. */
export const DEFAULT_VOXEL_STATE = 'AA==';

const MAX_RADIUS = 8;

function toBigInt(value: unknown): bigint {
  return BigInt(value as string | number | bigint);
}

export class HostCallRefusedError extends Error {
  constructor(readonly fn: string) {
    super(`host call '${fn}' is not offered by this game`);
    this.name = 'HostCallRefusedError';
  }
}

export async function routeClientHostCall(
  call: PlayerCodeHostCall,
  reads: ClientModHostReads,
  grid?: PlayerCodeGridBounds,
  writes?: ClientModHostWrites,
  input?: ClientModHostInput,
): Promise<unknown> {
  const { fn, args } = call;
  switch (fn) {
    case 'actors_list':
      return { actors: reads.actorsInChunk(toBigInt(args.x), toBigInt(args.y), toBigInt(args.z)) };
    case 'actors_list_radius': {
      const origin = { x: toBigInt(args.x), y: toBigInt(args.y), z: toBigInt(args.z) };
      const requested = Number(args.radius ?? args.r ?? 0);
      const radius = BigInt(
        Number.isFinite(requested) ? Math.max(0, Math.min(MAX_RADIUS, Math.floor(requested))) : 0,
      );
      const low = grid
        ? {
            x: maxBig(grid.low.x, origin.x - radius),
            y: maxBig(grid.low.y, origin.y - radius),
            z: maxBig(grid.low.z, origin.z - radius),
          }
        : origin;
      const high = grid
        ? {
            x: minBig(grid.high.x, origin.x + radius),
            y: minBig(grid.high.y, origin.y + radius),
            z: minBig(grid.high.z, origin.z + radius),
          }
        : origin;
      const actors: Array<Record<string, unknown>> = [];
      for (let x = low.x; x <= high.x; x++)
        for (let y = low.y; y <= high.y; y++)
          for (let z = low.z; z <= high.z; z++) actors.push(...reads.actorsInChunk(x, y, z));
      return { actors };
    }
    case 'chunk_get':
    case 'voxels_list': {
      const chunk = await reads.chunkVoxels(toBigInt(args.x), toBigInt(args.y), toBigInt(args.z));
      if (!chunk) return fn === 'chunk_get' ? { voxelsBase64: null } : { voxels: [] };
      return fn === 'chunk_get'
        ? { voxelsBase64: chunk.voxelsBase64 }
        : { voxels: voxelsListRows(chunk.voxelsBase64, chunk.states) };
    }
    case 'voxel_set': {
      if (!writes) throw new HostCallRefusedError(fn);
      const parsed = parseVoxelSetArgs(args);
      if (!parsed) return { ok: false, error: 'invalid voxel_set arguments' };
      const ok = await writes.setVoxel({
        chunk: parsed.chunk,
        x: parsed.x,
        y: parsed.y,
        z: parsed.z,
        voxelType: parsed.voxelType,
        state: parsed.state,
      });
      return { ok };
    }
    case 'pointer_clicks': {
      if (!input) throw new HostCallRefusedError(fn);
      return input.drainPointerClicks();
    }
    default:
      throw new HostCallRefusedError(fn);
  }
}

function intInRange(value: unknown, min: number, max: number): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value)
        ? Number(value)
        : typeof value === 'bigint'
          ? Number(value)
          : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function coordField(
  record: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function asCoord3(value: unknown): { x: unknown; y: unknown; z: unknown } | null {
  if (Array.isArray(value) && value.length >= 3) {
    return { x: value[0], y: value[1], z: value[2] };
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return { x: rec.x, y: rec.y, z: rec.z };
  }
  return null;
}

/** Accept the SDK tuple shape and the flattened host-call JSON the broker clamps. */
export function parseVoxelSetArgs(args: Record<string, unknown>): {
  chunk: { x: number; y: number; z: number };
  x: number;
  y: number;
  z: number;
  voxelType: number;
  state: string;
} | null {
  const chunkRaw =
    asCoord3(args.chunk) ??
    ({
      x: coordField(args, 'chunkX', 'chunk_x'),
      y: coordField(args, 'chunkY', 'chunk_y'),
      z: coordField(args, 'chunkZ', 'chunk_z'),
    } as { x: unknown; y: unknown; z: unknown });
  const voxelRaw =
    asCoord3(args.voxel) ??
    ({
      x: coordField(args, 'voxelX', 'voxel_x', 'x', 'vx'),
      y: coordField(args, 'voxelY', 'voxel_y', 'y', 'vy'),
      z: coordField(args, 'voxelZ', 'voxel_z', 'z', 'vz'),
    } as { x: unknown; y: unknown; z: unknown });
  const cx = intInRange(chunkRaw.x, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const cy = intInRange(chunkRaw.y, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const cz = intInRange(chunkRaw.z, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const x = intInRange(voxelRaw.x, 0, 15);
  const y = intInRange(voxelRaw.y, 0, 15);
  const z = intInRange(voxelRaw.z, 0, 15);
  const voxelType = intInRange(coordField(args, 'voxelType', 'voxel_type', 'type'), 0, 255);
  if (cx === null || cy === null || cz === null || x === null || y === null || z === null || voxelType === null) {
    return null;
  }
  const stateRaw = coordField(args, 'state', 'state_base64', 'stateBase64');
  const state = typeof stateRaw === 'string' && stateRaw.length > 0 ? stateRaw : DEFAULT_VOXEL_STATE;
  return { chunk: { x: cx, y: cy, z: cz }, x, y, z, voxelType, state };
}

/** Sparse `{x,y,z,voxelType}` rows for the non-zero cells of a dense grid. */
export function voxelsFromBase64(
  voxelsBase64: string | null,
): Array<{ x: number; y: number; z: number; voxelType: number; state?: string }> {
  if (!voxelsBase64) return [];
  const binary = atob(voxelsBase64);
  const out: Array<{ x: number; y: number; z: number; voxelType: number; state?: string }> = [];
  for (let i = 0; i < binary.length && i < 4096; i++) {
    const type = binary.charCodeAt(i);
    if (type === 0) continue;
    out.push({ x: i & 15, y: (i >> 4) & 15, z: (i >> 8) & 15, voxelType: type });
  }
  return out;
}

/** Dense types plus sparse per-cell state so mailbox voxels can carry JSON. */
export function voxelsListRows(
  voxelsBase64: string | null,
  states?: ClientVoxelState[],
): Array<{ x: number; y: number; z: number; voxelType: number; state?: string }> {
  const rows = voxelsFromBase64(voxelsBase64);
  if (!states?.length) return rows;
  for (const extra of states) {
    const row = rows.find((v) => v.x === extra.x && v.y === extra.y && v.z === extra.z);
    if (row) row.state = extra.state;
    else rows.push({ x: extra.x, y: extra.y, z: extra.z, voxelType: 0, state: extra.state });
  }
  return rows;
}

/** JSON mailbox payloads become base64; values that are already base64 pass through. */
export function voxelStateToWire(state: string): string {
  const trimmed = state.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return bytesToBase64(new TextEncoder().encode(state));
  }
  return state;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

interface CachedArtifact {
  bytes: Uint8Array;
  artifactHash?: string;
  fuelPerDispatch?: string | bigint;
}

const artifactCache = new Map<string, CachedArtifact>();

/**
 * Fetch a consented grid-attached client mod's artifact and run it in a
 * hash-verified broker with the same allowlist, grid clamp, rate caps and
 * circuit breaker as the Studio's own Test/Run path. Its HUD output lands in
 * the persistent text HUD. Returns null (fails closed) when the artifact
 * cannot be fetched.
 */
export async function runConsentedGridMod(options: {
  client: CrowdyClient;
  appId: string;
  attachmentId: string;
  artifactCacheKey: string;
  hudSource: string;
  hudLabel: string;
  grid: PlayerCodeGridBounds;
  workerUrl: string;
  reads: ClientModHostReads;
  writes?: ClientModHostWrites;
  hud: CrowdyStudioTextHud;
  overlay?: ModOverlayStore;
  input?: ClientModHostInput;
  /**
   * How often the worker self-drives `on_tick`. Omitted/0 means invoke-only
   * and a HUD mod then never runs (measured 2026-09-07: broker started, HUD
   * stayed empty). Studio Test/Deploy reads `[package.metadata.crowdy]
   * tick_interval_ms` from the CLIENT Cargo.toml (default 1000, clamped
   * 16–1000). Pass this only for grid-attached visitors until that field is
   * stored on the compiled version.
   */
  tickIntervalMs?: number;
}): Promise<{ stop: () => void } | null> {
  let fetched: { bytes: ArrayBuffer; artifactHash?: string; fuelPerDispatch?: string | bigint };
  const cached = artifactCache.get(options.artifactCacheKey);
  if (cached) {
    fetched = {
      bytes: cached.bytes.slice().buffer,
      artifactHash: cached.artifactHash,
      fuelPerDispatch: cached.fuelPerDispatch,
    };
  } else {
    try {
      fetched = await options.client.marketplace.clientArtifactBytes({
        appId: options.appId,
        attachmentId: options.attachmentId,
      });
    } catch {
      return null;
    }
    artifactCache.set(options.artifactCacheKey, {
      bytes: new Uint8Array(fetched.bytes).slice(),
      artifactHash: fetched.artifactHash,
      fuelPerDispatch: fetched.fuelPerDispatch,
    });
  }
  const broker = new PlayerCodeBroker({
    workerUrl: options.workerUrl,
    grid: options.grid,
    artifactHash: fetched.artifactHash,
    fuelPerDispatch: fetched.fuelPerDispatch != null ? BigInt(fetched.fuelPerDispatch) : undefined,
    tickIntervalMs: options.tickIntervalMs ?? 1000,
    onHostCall: (call) =>
      routeClientHostCall(call, options.reads, options.grid, options.writes, options.input),
    onPresentation: (presentation: PlayerCodePresentation) => {
      if (presentation.channel === 'hud') {
        options.hud.set({
          source: options.hudSource,
          label: options.hudLabel,
          payload: presentation.payload,
        });
      }
      if (presentation.channel === 'overlay') {
        options.overlay?.apply(options.hudSource, presentation.payload, options.grid);
      }
    },
    onCircuitOpen: () => {
      options.hud.remove(options.hudSource);
      options.overlay?.remove(options.hudSource);
    },
  });
  await broker.start(fetched.bytes);
  return {
    stop: () => {
      broker.stop();
      options.hud.remove(options.hudSource);
      options.overlay?.remove(options.hudSource);
    },
  };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
