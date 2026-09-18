import { describe, expect, it } from 'vitest';

import {
  claimedChunkAabb,
  claimedChunkBoxTransform,
  claimedChunksToDraw,
} from '@/scenes/holodeck-three/claimedChunkBox';

describe('claimedChunkAabb', () => {
  it('maps a one-chunk grid to a 16-unit world cube', () => {
    expect(
      claimedChunkAabb({
        low: { x: '-1', y: '0', z: '-1' },
        high: { x: '-1', y: '0', z: '-1' },
      }),
    ).toEqual({
      minX: -16,
      maxX: 0,
      minY: 0,
      maxY: 16,
      minZ: -16,
      maxZ: 0,
    });
  });
});

describe('claimedChunkBoxTransform', () => {
  it('centres the mesh on the AABB and lifts the floor edge', () => {
    const t = claimedChunkBoxTransform({
      minX: -16,
      maxX: 0,
      minY: 0,
      maxY: 16,
      minZ: -16,
      maxZ: 0,
    });
    expect(t.x).toBe(-8);
    expect(t.z).toBe(-8);
    expect(t.sx).toBe(16);
    expect(t.sz).toBe(16);
    expect(t.sy).toBeCloseTo(15.95);
    expect(t.y).toBeCloseTo(0.05 + 15.95 / 2);
  });
});

describe('claimedChunksToDraw', () => {
  const bounds = {
    low: { x: '-1', y: '0', z: '-1' },
    high: { x: '-1', y: '0', z: '-1' },
  };

  it('includes owned grids even when the player is standing elsewhere', () => {
    const drawn = claimedChunksToDraw({
      grid: {
        gridId: 'visitor',
        bounds: { low: { x: '0', y: '0', z: '0' }, high: { x: '0', y: '0', z: '0' } },
        owned: false,
      },
      grids: {
        ownedGrids: () => [{ gridId: '91159989710848', bounds }],
      },
    });
    expect(drawn).toEqual([{ gridId: '91159989710848', bounds }]);
  });

  it('outlines the standing grid when it is owned and not yet in the local map', () => {
    const drawn = claimedChunksToDraw({
      grid: { gridId: '91159989710848', bounds, owned: true },
      grids: { ownedGrids: () => [] },
    });
    expect(drawn).toEqual([{ gridId: '91159989710848', bounds }]);
  });
});
