/**
 * Crowdy Studio permissions and grid bounds, derived from what the platform
 * says and nothing else.
 *
 * A claim (or a nearby-grid read) returns the caller's EFFECTIVE permission
 * keys on that grid. SERVER and CLIENT write/run gates come from those exact
 * keys, independently; nothing here infers one target from the other or
 * inflates a partial key list.
 */
export const PLAYER_CODE_PERMISSION_KEYS = [
  'write_server_code',
  'run_server_code',
  'write_client_code',
  'run_client_code',
] as const;

export type PlayerCodePermissionKey = (typeof PLAYER_CODE_PERMISSION_KEYS)[number];

export interface TargetPermission {
  canWrite: boolean;
  canRun: boolean;
}

export interface StudioPermissions {
  effectiveKeys: PlayerCodePermissionKey[];
  server: TargetPermission;
  client: TargetPermission;
}

export const NO_STUDIO_PERMISSIONS: StudioPermissions = {
  effectiveKeys: [],
  server: { canWrite: false, canRun: false },
  client: { canWrite: false, canRun: false },
};

function isPlayerCodeKey(value: string): value is PlayerCodePermissionKey {
  return (PLAYER_CODE_PERMISSION_KEYS as readonly string[]).includes(value);
}

export function studioPermissions(
  effectiveKeys: readonly unknown[] | null | undefined,
): StudioPermissions {
  const keys = new Set((effectiveKeys ?? []).map(String).filter(isPlayerCodeKey));
  return {
    effectiveKeys: PLAYER_CODE_PERMISSION_KEYS.filter((key) => keys.has(key)),
    server: { canWrite: keys.has('write_server_code'), canRun: keys.has('run_server_code') },
    client: { canWrite: keys.has('write_client_code'), canRun: keys.has('run_client_code') },
  };
}

export function hasAnyStudioPermission(permissions: StudioPermissions | null | undefined): boolean {
  return Boolean(
    permissions &&
    (permissions.server.canWrite ||
      permissions.server.canRun ||
      permissions.client.canWrite ||
      permissions.client.canRun),
  );
}

/** A grid's chunk AABB, as decimal strings (int64 on the wire). */
export interface GridBounds {
  low: { x: string; y: string; z: string };
  high: { x: string; y: string; z: string };
}

function decimalInteger(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null;
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return null;
  return BigInt(value).toString();
}

function parseCorner(value: unknown): { x: string; y: string; z: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const x = decimalInteger(record.x);
  const y = decimalInteger(record.y);
  const z = decimalInteger(record.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

/** Authoritative bounds from a claim/nearby response; null when malformed. */
export function gridBoundsFrom(low: unknown, high: unknown): GridBounds | null {
  const l = parseCorner(low);
  const h = parseCorner(high);
  if (!l || !h) return null;
  if (BigInt(l.x) > BigInt(h.x) || BigInt(l.y) > BigInt(h.y) || BigInt(l.z) > BigInt(h.z))
    return null;
  return { low: l, high: h };
}

export function singleChunkBounds(chunk: {
  x: number | string;
  y: number | string;
  z: number | string;
}): GridBounds {
  const corner = { x: String(chunk.x), y: String(chunk.y), z: String(chunk.z) };
  return { low: corner, high: { ...corner } };
}

export function gridBoundsContain(
  bounds: GridBounds,
  chunk: { x: number | string; y: number | string; z: number | string },
): boolean {
  const x = BigInt(chunk.x);
  const y = BigInt(chunk.y);
  const z = BigInt(chunk.z);
  return (
    x >= BigInt(bounds.low.x) &&
    x <= BigInt(bounds.high.x) &&
    y >= BigInt(bounds.low.y) &&
    y <= BigInt(bounds.high.y) &&
    z >= BigInt(bounds.low.z) &&
    z <= BigInt(bounds.high.z)
  );
}

/** The bigint form the SDK's broker and embed expect. */
export function toBrokerBounds(bounds: GridBounds): {
  low: { x: bigint; y: bigint; z: bigint };
  high: { x: bigint; y: bigint; z: bigint };
} {
  return {
    low: { x: BigInt(bounds.low.x), y: BigInt(bounds.low.y), z: BigInt(bounds.low.z) },
    high: { x: BigInt(bounds.high.x), y: BigInt(bounds.high.y), z: BigInt(bounds.high.z) },
  };
}
