import { describe, expect, it } from 'vitest';

import { acceptVoiceSequence, muLawDecode, muLawEncode } from '@/platform/media/mulaw';

describe('mu-law', () => {
  it('round-trips silence and a peak within a loose tolerance', () => {
    expect(muLawDecode(muLawEncode(0))).toBeCloseTo(0, 2);
    expect(muLawDecode(muLawEncode(0.5))).toBeGreaterThan(0.4);
    expect(muLawDecode(muLawEncode(-0.5))).toBeLessThan(-0.4);
  });
});

describe('acceptVoiceSequence', () => {
  it('drops duplicates and stale wraps, and resets after a gap', () => {
    expect(acceptVoiceSequence(5, 5, 10, 1500).accept).toBe(false);
    expect(acceptVoiceSequence(5, 4, 10, 1500).accept).toBe(false);
    expect(acceptVoiceSequence(5, 6, 10, 1500)).toEqual({ accept: true, nextSequence: 6 });
    expect(acceptVoiceSequence(5, 1, 2000, 1500)).toEqual({ accept: true, nextSequence: 1 });
  });
});
