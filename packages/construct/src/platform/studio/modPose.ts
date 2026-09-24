/**
 * Generic body hold for a client mod. The mod sends positions; the holodeck
 * hides the pill while a hold is active and restores it when the mod stops.
 */
import type { PlayerCodeGridBounds } from '@crowdedkingdoms/crowdyjs';

import { CHUNK_SIZE } from '../config';
import { worldToChunk } from '../realtime/space';

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
}

let hold: ModPoseHold | null = null;
let grid: PlayerCodeGridBounds | null = null;
let walker: ModPoseHold = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  vx: 0,
  vy: 0,
  vz: 0,
};

export function setModPoseGrid(next: PlayerCodeGridBounds | null): void {
  grid = next;
}

export function clearModPose(): void {
  hold = null;
}

export function currentModPose(): ModPoseHold | null {
  return hold;
}

/** Where the walker is, so a mod can take the body from that spot. */
export function noteWalkerPose(pose: Pick<ModPoseHold, 'x' | 'y' | 'z' | 'yaw' | 'pitch'>): void {
  if (hold) return;
  walker = { ...walker, ...pose, roll: 0, vx: 0, vy: 0, vz: 0 };
}

export function poseSnapshot(): Record<string, unknown> {
  const pose = hold ?? walker;
  return { held: hold !== null, ...pose };
}

export function positionInModGrid(x: number, y: number, z: number): boolean {
  if (!grid) return false;
  const chunk = worldToChunk({ x, y, z });
  return (
    chunk.x >= Number(grid.low.x) &&
    chunk.x <= Number(grid.high.x) &&
    chunk.y >= Number(grid.low.y) &&
    chunk.y <= Number(grid.high.y) &&
    chunk.z >= Number(grid.low.z) &&
    chunk.z <= Number(grid.high.z)
  );
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function applyPoseSet(args: Record<string, unknown>): { ok: boolean; error?: string } {
  const x = num(args.x);
  const y = num(args.y);
  const z = num(args.z);
  if (!positionInModGrid(x, y, z)) return { ok: false, error: 'outside the player grid' };
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
  };
  return { ok: true };
}

export function stepModPose(dt: number): ModPoseHold | null {
  if (!hold || !grid) return hold;
  hold.x += hold.vx * dt;
  hold.y += hold.vy * dt;
  hold.z += hold.vz * dt;
  const minX = Number(grid.low.x) * CHUNK_SIZE + 0.4;
  const maxX = (Number(grid.high.x) + 1) * CHUNK_SIZE - 0.4;
  const minY = Number(grid.low.y) * CHUNK_SIZE + 0.05;
  const maxY = (Number(grid.high.y) + 1) * CHUNK_SIZE - 0.4;
  const minZ = Number(grid.low.z) * CHUNK_SIZE + 0.4;
  const maxZ = (Number(grid.high.z) + 1) * CHUNK_SIZE - 0.4;
  hold.x = Math.min(maxX, Math.max(minX, hold.x));
  hold.y = Math.min(maxY, Math.max(minY, hold.y));
  hold.z = Math.min(maxZ, Math.max(minZ, hold.z));
  return hold;
}
