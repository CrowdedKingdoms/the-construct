/**
 * The host side of CLIENT mods: what a sandboxed player module may ask the
 * game for, and how a consented grid-attached mod is started for a visitor.
 *
 * The SDK's `PlayerCodeBroker` has already validated every call against the
 * platform allowlist, clamped chunk coordinates to the mod's grid AABB, rate-
 * limited it, and answered `grid_info` / `hud_set` itself. What reaches
 * `routeClientHostCall` is the `world_read` family, and this router returns
 * only what the running player can already lawfully see — in-grid actors and
 * the cached voxel view — so a client mod can never read beyond its grid or
 * act as anyone but the player running it. Anything else is refused.
 *
 * A game that wants mods to do more (write voxels, invoke model functions)
 * adds cases here that go through the same player-authorized SDK paths the
 * human UI uses. Never hand a mod the raw client.
 */
import {
  PlayerCodeBroker,
  type CrowdyClient,
  type PlayerCodeGridBounds,
  type PlayerCodeHostCall,
  type PlayerCodePresentation,
} from '@crowdedkingdoms/crowdyjs';
import type { CrowdyStudioTextHud } from '@crowdedkingdoms/crowdyjs/crowdy-studio';

export interface ClientModHostReads {
  actorsInChunk(x: bigint, y: bigint, z: bigint): Array<Record<string, unknown>>;
  chunkVoxels(x: bigint, y: bigint, z: bigint): { voxelsBase64: string | null } | null;
}

/** The host calls this game answers. Exported so the docs and tests agree. */
export const OFFERED_HOST_CALLS = ['actors_list', 'actors_list_radius', 'chunk_get', 'voxels_list'] as const;

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
        ? { x: maxBig(grid.low.x, origin.x - radius), y: maxBig(grid.low.y, origin.y - radius), z: maxBig(grid.low.z, origin.z - radius) }
        : origin;
      const high = grid
        ? { x: minBig(grid.high.x, origin.x + radius), y: minBig(grid.high.y, origin.y + radius), z: minBig(grid.high.z, origin.z + radius) }
        : origin;
      const actors: Array<Record<string, unknown>> = [];
      for (let x = low.x; x <= high.x; x++)
        for (let y = low.y; y <= high.y; y++)
          for (let z = low.z; z <= high.z; z++) actors.push(...reads.actorsInChunk(x, y, z));
      return { actors };
    }
    case 'chunk_get':
    case 'voxels_list': {
      const chunk = reads.chunkVoxels(toBigInt(args.x), toBigInt(args.y), toBigInt(args.z));
      if (!chunk) return fn === 'chunk_get' ? { voxelsBase64: null } : { voxels: [] };
      return fn === 'chunk_get'
        ? { voxelsBase64: chunk.voxelsBase64 }
        : { voxels: voxelsFromBase64(chunk.voxelsBase64) };
    }
    default:
      throw new HostCallRefusedError(fn);
  }
}

/** Sparse `{x,y,z,voxelType}` rows for the non-zero cells of a dense grid. */
export function voxelsFromBase64(voxelsBase64: string | null): Array<{ x: number; y: number; z: number; voxelType: number }> {
  if (!voxelsBase64) return [];
  const binary = atob(voxelsBase64);
  const out: Array<{ x: number; y: number; z: number; voxelType: number }> = [];
  for (let i = 0; i < binary.length && i < 4096; i++) {
    const type = binary.charCodeAt(i);
    if (type === 0) continue;
    out.push({ x: i & 15, y: (i >> 4) & 15, z: (i >> 8) & 15, voxelType: type });
  }
  return out;
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
  hud: CrowdyStudioTextHud;
}): Promise<{ stop: () => void } | null> {
  let fetched: { bytes: ArrayBuffer; artifactHash?: string; fuelPerDispatch?: string | bigint };
  const cached = artifactCache.get(options.artifactCacheKey);
  if (cached) {
    fetched = { bytes: cached.bytes.slice().buffer, artifactHash: cached.artifactHash, fuelPerDispatch: cached.fuelPerDispatch };
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
    onHostCall: (call) => routeClientHostCall(call, options.reads, options.grid),
    onPresentation: (presentation: PlayerCodePresentation) => {
      if (presentation.channel === 'hud') {
        options.hud.set({ source: options.hudSource, label: options.hudLabel, payload: presentation.payload });
      }
    },
    onCircuitOpen: () => options.hud.remove(options.hudSource),
  });
  await broker.start(fetched.bytes);
  return {
    stop: () => {
      broker.stop();
      options.hud.remove(options.hudSource);
    },
  };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
