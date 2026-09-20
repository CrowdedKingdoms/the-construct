import { describe, expect, it } from 'vitest';

import { voxelColor, voxelWorldPosition } from '@/scenes/holodeck-three/voxels';

describe('voxelWorldPosition', () => {
  it('places the cube centre in world units', () => {
    expect(voxelWorldPosition({ x: 3, y: 0, z: 3 }, 8, 1, 4)).toEqual({
      x: 3 * 16 + 8 + 0.5,
      y: 1.5,
      z: 3 * 16 + 4 + 0.5,
    });
  });
});

describe('voxelColor', () => {
  it('maps type 1 to felt green', () => {
    expect(voxelColor(1)).toBe(0x14532d);
  });
});
