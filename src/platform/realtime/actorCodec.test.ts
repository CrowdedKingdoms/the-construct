import { describe, expect, it } from 'vitest';

import {
  FLAG_IN_PROGRAM,
  FLAG_STUDIO_OPEN,
  NAME_BYTES,
  NEUTRAL_POSE,
  POSE_BYTES,
  decodeName,
  encodeName,
  poseCodec,
  type Pose,
} from '@/platform/realtime/actorCodec';

describe('poseCodec', () => {
  it('is a fixed 64-byte layout', () => {
    expect(POSE_BYTES).toBe(64);
    const bytes = atob(poseCodec.encode(NEUTRAL_POSE)).length;
    expect(bytes).toBe(64);
  });

  it('round-trips a pose (floats to f32 precision)', () => {
    const pose: Pose = {
      x: 12.5,
      y: 0.25,
      z: -7.75,
      yaw: 1.5,
      pitch: -0.125,
      vx: 3,
      vy: 0,
      vz: -1.5,
      flags: FLAG_IN_PROGRAM | FLAG_STUDIO_OPEN,
      program: 1,
      tint: 5,
      name: 'neo',
    };
    const decoded = poseCodec.decode(poseCodec.encode(pose));
    expect(decoded).toEqual(pose);
  });

  it('truncates names to the byte budget without splitting a character', () => {
    const long = 'ünïcödé-name-that-is-far-too-long-for-the-wire';
    const encoded = encodeName(long);
    expect(encoded.length).toBe(NAME_BYTES);
    const back = decodeName(encoded);
    expect(long.startsWith(back)).toBe(true);
    expect(new TextEncoder().encode(back).length).toBeLessThanOrEqual(NAME_BYTES);
  });

  it('masks flag/program/tint to one byte', () => {
    const decoded = poseCodec.decode(
      poseCodec.encode({ ...NEUTRAL_POSE, flags: 0x1ff, program: 300, tint: 264 }),
    );
    expect(decoded.flags).toBe(0xff);
    expect(decoded.program).toBe(300 & 0xff);
    expect(decoded.tint).toBe(264 & 0xff);
  });

  it('refuses a payload shorter than the layout', () => {
    expect(() => poseCodec.decode('AA==')).toThrow(/structCodec/);
  });
});
