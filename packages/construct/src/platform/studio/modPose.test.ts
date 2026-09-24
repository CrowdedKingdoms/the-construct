import { describe, expect, it, beforeEach } from 'vitest';

import {
  applyPoseSet,
  clearModPose,
  positionInModGrid,
  setModPoseGrid,
  stepModPose,
} from './modPose';

describe('mod pose hold', () => {
  beforeEach(() => {
    clearModPose();
    setModPoseGrid({
      low: { x: -4n, y: 0n, z: -4n },
      high: { x: -1n, y: 0n, z: -1n },
    });
  });

  it('refuses a pose outside the grid and accepts one inside', () => {
    expect(positionInModGrid(0, 0, 0)).toBe(false);
    expect(applyPoseSet({ x: 0, y: 0, z: 0 })).toEqual({
      ok: false,
      error: 'outside the player grid',
    });
    expect(applyPoseSet({ x: -8, y: 1, z: -8, yaw: 0.2 })).toEqual({ ok: true });
  });

  it('integrates velocity and stays inside the grid box', () => {
    applyPoseSet({ x: -63, y: 1, z: -8, vx: -10, vy: 0, vz: 0 });
    const next = stepModPose(1);
    expect(next?.x).toBeCloseTo(-63.6);
  });
});
