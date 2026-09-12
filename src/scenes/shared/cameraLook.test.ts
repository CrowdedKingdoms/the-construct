import { describe, expect, it } from 'vitest';

import {
  LOOK_PITCH_MAX,
  LOOK_PITCH_MIN,
  applyLook,
  followCameraOffset,
  panOffset,
  zoomDistance,
} from '@/scenes/shared/cameraLook';

describe('applyLook', () => {
  it('turns right when the mouse moves right and looks up when it moves up', () => {
    const right = applyLook(0, 0, 100, 0, 0.01);
    expect(right.yaw).toBeLessThan(0);
    const up = applyLook(0, 0, 0, -100, 0.01);
    expect(up.pitch).toBeGreaterThan(0);
  });

  it('clamps pitch', () => {
    const high = applyLook(0, LOOK_PITCH_MAX, 0, -10_000, 1);
    expect(high.pitch).toBe(LOOK_PITCH_MAX);
    const low = applyLook(0, LOOK_PITCH_MIN, 0, 10_000, 1);
    expect(low.pitch).toBe(LOOK_PITCH_MIN);
  });
});

describe('followCameraOffset', () => {
  it('sits behind the avatar at yaw 0 (positive Z)', () => {
    const at = followCameraOffset(0, 0, 6, 3);
    expect(at.x).toBeCloseTo(0, 5);
    expect(at.z).toBeCloseTo(6, 5);
    expect(at.y).toBeCloseTo(3, 5);
  });
});

describe('zoomDistance', () => {
  it('zooms in on wheel up and clamps', () => {
    const closer = zoomDistance(8, -400, 2.5, 14);
    expect(closer).toBeLessThan(8);
    expect(zoomDistance(3, -10_000, 2.5, 14)).toBe(2.5);
    expect(zoomDistance(10, 10_000, 2.5, 14)).toBe(14);
  });
});

describe('panOffset', () => {
  it('dragging right moves the view right in world units', () => {
    const next = panOffset(0, 0, 28, 0, 28);
    expect(next.x).toBeCloseTo(-1, 5);
    expect(next.z).toBe(0);
  });
});
