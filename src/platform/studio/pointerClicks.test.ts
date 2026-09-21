import { describe, expect, it } from 'vitest';

import { PointerClickBuffer } from '@/platform/studio/pointerClicks';

describe('PointerClickBuffer', () => {
  it('drains queued clicks and reports live hold time', () => {
    let now = 1_000;
    const buf = new PointerClickBuffer(() => now);
    buf.push({ t: 'down', button: 0, atMs: 1_000, nx: 0.2, ny: -0.1 }, 1);
    now = 1_080;
    const held = buf.drainPointerClicks();
    expect(held.clicks).toEqual([{ t: 'down', button: 0, atMs: 1_000, nx: 0.2, ny: -0.1 }]);
    expect(held.buttons).toBe(1);
    expect(held.holdingMs).toEqual({ '0': 80 });
    now = 1_200;
    buf.push({ t: 'up', button: 0, atMs: 1_200, heldMs: 200, nx: 0.2, ny: -0.1 }, 0);
    const released = buf.drainPointerClicks();
    expect(released.clicks[0]?.heldMs).toBe(200);
    expect(released.buttons).toBe(0);
    expect(released.holdingMs).toEqual({});
    expect(buf.drainPointerClicks().clicks).toEqual([]);
  });
});
