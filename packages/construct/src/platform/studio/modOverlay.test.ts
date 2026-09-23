import { describe, expect, it } from 'vitest';

import { MAX_OVERLAY_OBJECTS, ModOverlayStore, parseOverlayPayload } from './modOverlay';

const grid = { low: { x: 3n, y: 0n, z: 3n }, high: { x: 3n, y: 0n, z: 3n } };

describe('parseOverlayPayload', () => {
  it('reads an objects list and clamps to the grid AABB', () => {
    const rows = parseOverlayPayload(
      {
        objects: [
          { id: 'cue', shape: 'sphere', x: 56, y: 0.5, z: 56, r: 0.08, color: '#f8fafc' },
          { id: 'far', x: 0, y: 0, z: 0 },
        ],
      },
      grid,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'cue', shape: 'sphere', x: 56, z: 56 });
    expect(rows[0]?.sx).toBeCloseTo(0.08);
    expect(rows[1]?.x).toBe(48); // 3 * 16
    expect(rows[1]?.z).toBe(48);
  });

  it('caps the list and ignores duplicates', () => {
    const objects = Array.from({ length: MAX_OVERLAY_OBJECTS + 5 }, (_, i) => ({
      id: i < 2 ? 'same' : `b${i}`,
      x: 50,
      z: 50,
    }));
    expect(parseOverlayPayload({ objects })).toHaveLength(MAX_OVERLAY_OBJECTS);
  });

  it('never treats a string as HTML', () => {
    expect(parseOverlayPayload('<div id="x">nope</div>')).toEqual([]);
    expect(parseOverlayPayload({ objects: [{ x: 1, z: 1, color: '<script>' }] })[0]?.color).toBe(
      0xf8fafc,
    );
  });
});

describe('ModOverlayStore', () => {
  it('merges sources and drops one on remove', () => {
    const store = new ModOverlayStore();
    store.apply('a', { objects: [{ id: 'one', x: 1, z: 1 }] });
    store.apply('b', { objects: [{ id: 'two', x: 2, z: 2 }] });
    expect(
      store
        .snapshot()
        .objects.map((o) => o.id)
        .sort(),
    ).toEqual(['one', 'two']);
    store.remove('a');
    expect(store.snapshot().objects.map((o) => o.id)).toEqual(['two']);
  });
});
