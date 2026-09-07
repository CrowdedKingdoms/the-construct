/**
 * World <-> chunk math. Everything realtime on Crowded Kingdoms is addressed
 * to a chunk and fanned out within `distance` chunks; the game decides what a
 * chunk means in world units. The Construct uses 16 units per chunk on all
 * three axes and keeps the holodeck floor at world y in [0, 16), i.e. chunk
 * layer 0.
 */
import type { ChunkCoordinatesInput } from '@crowdedkingdoms/crowdyjs';

import { CHUNK_SIZE } from '@/platform/config';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ChunkCoord {
  x: number;
  y: number;
  z: number;
}

export function worldToChunk(position: Vec3, size: number = CHUNK_SIZE): ChunkCoord {
  return {
    x: Math.floor(position.x / size),
    y: Math.floor(position.y / size),
    z: Math.floor(position.z / size),
  };
}

/** World position -> the voxel cell inside its chunk (0..size-1 on each axis). */
export function worldToVoxel(position: Vec3, size: number = CHUNK_SIZE): ChunkCoord {
  const mod = (v: number) => ((Math.floor(v) % size) + size) % size;
  return { x: mod(position.x), y: mod(position.y), z: mod(position.z) };
}

/** The wire form: chunk coordinates travel as decimal strings (int64). */
export function chunkInput(chunk: ChunkCoord | ChunkCoordinatesInput): ChunkCoordinatesInput {
  return { x: String(chunk.x), y: String(chunk.y), z: String(chunk.z) };
}

export function chunkFromInput(
  chunk: ChunkCoordinatesInput | { x: unknown; y: unknown; z: unknown },
): ChunkCoord {
  return { x: Number(chunk.x), y: Number(chunk.y), z: Number(chunk.z) };
}

export function chunkKey(chunk: ChunkCoord | ChunkCoordinatesInput): string {
  return `${chunk.x},${chunk.y},${chunk.z}`;
}

export function sameChunk(
  a: ChunkCoord | ChunkCoordinatesInput,
  b: ChunkCoord | ChunkCoordinatesInput,
): boolean {
  return String(a.x) === String(b.x) && String(a.y) === String(b.y) && String(a.z) === String(b.z);
}

/** Chebyshev distance in chunks — the metric the platform fans out with. */
export function chunkDistance(a: ChunkCoord, b: ChunkCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}
