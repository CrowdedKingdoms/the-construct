import { describe, expect, it } from 'vitest';

import { AgentLocomotion } from '@/platform/studio/agentLocomotion';

describe('AgentLocomotion', () => {
  it('maps MOVE directions onto Input.axes and expires them', () => {
    const loco = new AgentLocomotion();
    loco.applyMove({ direction: 'FORWARD', intensity: 1, durationMs: 200, nowMs: 1_000 });
    expect(loco.sample(1_050)).toMatchObject({ x: 0, y: 1, yaw: 0, pitch: 0 });
    loco.applyMove({ direction: 'LEFT', intensity: 0.5, durationMs: 200, nowMs: 1_100 });
    expect(loco.sample(1_150).x).toBe(-0.5);
    expect(loco.sample(1_400)).toMatchObject({ x: 0, y: 0 });
  });

  it('converts LOOK degrees to radians once, then clears', () => {
    const loco = new AgentLocomotion();
    loco.applyLook({ deltaYaw: 90, deltaPitch: -45 });
    const first = loco.sample(0);
    expect(first.yaw).toBeCloseTo(Math.PI / 2, 5);
    expect(first.pitch).toBeCloseTo(-Math.PI / 4, 5);
    expect(loco.sample(1)).toMatchObject({ yaw: 0, pitch: 0 });
  });

  it('clear drops both wishes', () => {
    const loco = new AgentLocomotion();
    loco.applyMove({ direction: 'RIGHT', intensity: 1, durationMs: 1_000, nowMs: 0 });
    loco.applyLook({ deltaYaw: 10, deltaPitch: 0 });
    loco.clear();
    expect(loco.sample(10)).toEqual({ x: 0, y: 0, yaw: 0, pitch: 0 });
  });
});
