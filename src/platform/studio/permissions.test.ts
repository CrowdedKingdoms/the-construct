import { describe, expect, it } from 'vitest';

import {
  gridBoundsContain,
  gridBoundsFrom,
  hasAnyStudioPermission,
  singleChunkBounds,
  studioPermissions,
  toBrokerBounds,
} from '@/platform/studio/permissions';

describe('studioPermissions', () => {
  it('derives SERVER and CLIENT gates independently from the exact keys', () => {
    const p = studioPermissions(['write_server_code', 'run_client_code', 'access', 'bogus']);
    expect(p.effectiveKeys).toEqual(['write_server_code', 'run_client_code']);
    expect(p.server).toEqual({ canWrite: true, canRun: false });
    expect(p.client).toEqual({ canWrite: false, canRun: true });
  });

  it('never inflates a missing or empty key list', () => {
    expect(hasAnyStudioPermission(studioPermissions(undefined))).toBe(false);
    expect(hasAnyStudioPermission(studioPermissions([]))).toBe(false);
    expect(hasAnyStudioPermission(studioPermissions(['run_server_code']))).toBe(true);
  });
});

describe('grid bounds', () => {
  it('parses authoritative bounds from strings, numbers and bigints', () => {
    expect(gridBoundsFrom({ x: '-1', y: 0, z: 2n }, { x: '3', y: '0', z: '2' })).toEqual({
      low: { x: '-1', y: '0', z: '2' },
      high: { x: '3', y: '0', z: '2' },
    });
  });

  it('rejects malformed or inverted bounds', () => {
    expect(gridBoundsFrom(null, { x: '1', y: '1', z: '1' })).toBeNull();
    expect(gridBoundsFrom({ x: '2', y: '0', z: '0' }, { x: '1', y: '0', z: '0' })).toBeNull();
    expect(gridBoundsFrom({ x: '1.5', y: '0', z: '0' }, { x: '1', y: '0', z: '0' })).toBeNull();
  });

  it('tests containment inclusively and converts for the broker', () => {
    const bounds = gridBoundsFrom({ x: '-1', y: '0', z: '-1' }, { x: '1', y: '0', z: '1' })!;
    expect(gridBoundsContain(bounds, { x: 1, y: 0, z: -1 })).toBe(true);
    expect(gridBoundsContain(bounds, { x: 2, y: 0, z: 0 })).toBe(false);
    expect(gridBoundsContain(bounds, { x: 0, y: 1, z: 0 })).toBe(false);
    expect(toBrokerBounds(singleChunkBounds({ x: 5, y: 0, z: -3 }))).toEqual({
      low: { x: 5n, y: 0n, z: -3n },
      high: { x: 5n, y: 0n, z: -3n },
    });
  });
});
