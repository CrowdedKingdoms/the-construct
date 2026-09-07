import { describe, expect, it } from 'vitest';

import {
  chunkDistance,
  chunkInput,
  chunkKey,
  sameChunk,
  worldToChunk,
  worldToVoxel,
} from '@/platform/realtime/space';

describe('space', () => {
  it('maps world positions to 16-unit chunks with floor semantics', () => {
    expect(worldToChunk({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(worldToChunk({ x: 15.9, y: 1, z: -0.1 })).toEqual({ x: 0, y: 0, z: -1 });
    expect(worldToChunk({ x: -16, y: 32, z: 17 })).toEqual({ x: -1, y: 2, z: 1 });
  });

  it('maps world positions to in-chunk voxel cells, including negatives', () => {
    expect(worldToVoxel({ x: 3.2, y: 0, z: 17 })).toEqual({ x: 3, y: 0, z: 1 });
    expect(worldToVoxel({ x: -1, y: 0, z: -16 })).toEqual({ x: 15, y: 0, z: 0 });
  });

  it('produces the string wire form and stable keys', () => {
    expect(chunkInput({ x: -1, y: 0, z: 7 })).toEqual({ x: '-1', y: '0', z: '7' });
    expect(chunkKey({ x: -1, y: 0, z: 7 })).toBe('-1,0,7');
    expect(sameChunk({ x: 1, y: 2, z: 3 }, { x: '1', y: '2', z: '3' })).toBe(true);
  });

  it('uses Chebyshev distance like the platform fan-out', () => {
    expect(chunkDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: -1, z: 2 })).toBe(3);
  });
});
