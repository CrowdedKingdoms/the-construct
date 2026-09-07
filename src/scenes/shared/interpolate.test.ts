import { describe, expect, it } from 'vitest';

import { NEUTRAL_POSE, type Pose } from '@/platform/realtime/actorCodec';
import type { RemotePlayer } from '@/platform/realtime/WorldStores';
import { RENDER_DELAY_MS, displayPose, tintColor } from '@/scenes/shared/interpolate';

function player(samples: Array<{ x: number; vx?: number; receivedAt: number }>): RemotePlayer {
  const poses = samples.map((s) => ({
    pose: { ...NEUTRAL_POSE, x: s.x, vx: s.vx ?? 0 } as Pose,
    epochMillis: s.receivedAt,
    receivedAt: s.receivedAt,
  }));
  return {
    uuid: 'u',
    pose: poses[0]!.pose,
    samples: poses,
    chunk: { x: 0, y: 0, z: 0 },
    receivedAt: poses[0]!.receivedAt,
  };
}

describe('displayPose', () => {
  it('interpolates between the two newest samples at the render delay', () => {
    const now = 10_000;
    const p = player([
      { x: 10, receivedAt: now - RENDER_DELAY_MS + 100 }, // newest
      { x: 0, receivedAt: now - RENDER_DELAY_MS - 100 }, // older
    ]);
    expect(displayPose(p, now).x).toBeCloseTo(5, 5);
  });

  it('extrapolates along velocity when the newest sample is already old, bounded', () => {
    const now = 10_000;
    const p = player([{ x: 10, vx: 2, receivedAt: now - RENDER_DELAY_MS - 200 }]);
    expect(displayPose(p, now).x).toBeCloseTo(10 + 2 * 0.2, 5);
    const stale = player([{ x: 10, vx: 2, receivedAt: now - 5000 }]);
    expect(displayPose(stale, now).x).toBeCloseTo(10 + 2 * 0.4, 5);
  });

  it('falls back to the last pose with no samples', () => {
    const p = player([{ x: 3, receivedAt: 0 }]);
    p.samples = [];
    expect(displayPose(p, 1).x).toBe(3);
  });
});

describe('tintColor', () => {
  it('wraps around the palette', () => {
    expect(tintColor(0)).toBe(tintColor(8));
    expect(tintColor(-1)).toBe(tintColor(7));
  });
});
