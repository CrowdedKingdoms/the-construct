/**
 * Draw the World Stores voxel cache as cubes in the holodeck. Paint already
 * showed the same cells in 2D; CLIENT `voxel_set` writes the same cache, and
 * realtime merges mean every player in range sees the same blocks.
 */
import * as THREE from 'three';

import { CHUNK_SIZE } from '@/platform/config';
import type { ChunkCoord } from '@/platform/realtime/space';
import { chunkKey, worldToChunk } from '@/platform/realtime/space';
import { TINT_COLORS } from '@/scenes/shared/interpolate';

const DRAW_RADIUS = 2;
const MAX_INSTANCES = 4096;
const BOX = new THREE.BoxGeometry(0.92, 0.92, 0.92);

export const VOXEL_COLORS: readonly number[] = [
  0x14532d, // 1 felt / grass
  0x6b3a1f, // 2 wood
  0xf8fafc, // 3 cue / white
  ...TINT_COLORS,
  0x111827, // eight-ball
];

export function voxelWorldPosition(
  chunk: ChunkCoord,
  vx: number,
  vy: number,
  vz: number,
  size: number = CHUNK_SIZE,
): { x: number; y: number; z: number } {
  return {
    x: chunk.x * size + vx + 0.5,
    y: chunk.y * size + vy + 0.5,
    z: chunk.z * size + vz + 0.5,
  };
}

export function voxelColor(voxelType: number): number {
  if (voxelType <= 0) return 0x14532d;
  return VOXEL_COLORS[(voxelType - 1) % VOXEL_COLORS.length] ?? 0x14532d;
}

export interface VoxelChunkSource {
  revision: number;
  get(coord: ChunkCoord): { voxels?: Uint8Array | null } | undefined;
}

export class VoxelLayer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private lastChunkRevision = -1;
  private lastCenterKey = '';

  constructor(private readonly scene: THREE.Scene) {
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      metalness: 0.08,
    });
    this.mesh = new THREE.InstancedMesh(BOX, material, MAX_INSTANCES);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  sync(chunks: VoxelChunkSource, world: { x: number; y: number; z: number }): void {
    const center = worldToChunk(world);
    const centerKey = chunkKey(center);
    if (chunks.revision === this.lastChunkRevision && centerKey === this.lastCenterKey) return;
    this.lastChunkRevision = chunks.revision;
    this.lastCenterKey = centerKey;

    const color = new THREE.Color();
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -DRAW_RADIUS; dx <= DRAW_RADIUS; dx++) {
        for (let dz = -DRAW_RADIUS; dz <= DRAW_RADIUS; dz++) {
          const coord: ChunkCoord = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
          const voxels = chunks.get(coord)?.voxels;
          if (!voxels) continue;
          for (let i = 0; i < voxels.length && i < 4096; i++) {
            const type = voxels[i] ?? 0;
            if (type === 0) continue;
            if (count >= MAX_INSTANCES) break;
            const vx = i & 15;
            const vy = (i >> 4) & 15;
            const vz = (i >> 8) & 15;
            const pos = voxelWorldPosition(coord, vx, vy, vz);
            this.dummy.position.set(pos.x, pos.y, pos.z);
            this.dummy.updateMatrix();
            this.mesh.setMatrixAt(count, this.dummy.matrix);
            color.setHex(voxelColor(type));
            this.mesh.setColorAt(count, color);
            count += 1;
          }
        }
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    (this.mesh.material as THREE.Material).dispose();
  }
}
