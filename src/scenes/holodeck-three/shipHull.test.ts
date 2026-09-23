import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { hullHit, hullHitSegment, laserPoint } from '@/scenes/holodeck-three/chunkCombat';
import { inRangeChunk } from '@/scenes/holodeck-three/chunkFlight';
import { buildHull, disposeHull, hullForName } from '@/scenes/holodeck-three/shipHull';

describe('range ships', () => {
  it('gives Alice and Bob their own hulls', () => {
    expect(hullForName('Alice')).toBe('wolfen');
    expect(hullForName('Bob')).toBe('pod');
    expect(hullForName('You')).toBe('arwing');
  });

  it('builds a winged hull rather than a single capsule', () => {
    const hull = buildHull('arwing', 0xff3344, 0xffd166);
    const meshes = hull.children.filter((child) => child instanceof THREE.Mesh);
    expect(meshes.length).toBeGreaterThan(3);
    disposeHull(hull);
  });

  it('hits a hull the laser has reached and misses one it has not', () => {
    const origin = { x: -8, y: 5, z: -4 };
    const direction = { x: 0, y: 0, z: -1 };
    const shot = laserPoint(origin, direction, 0.1);
    expect(hullHit(shot, { x: -8, y: 5, z: -8 })).toBe(true);
    expect(hullHit(shot, { x: -8, y: 5, z: -14 })).toBe(false);
    expect(
      hullHitSegment({ x: -8, y: 5, z: -2 }, { x: -8, y: 5, z: -14 }, { x: -8, y: 5, z: -8 }),
    ).toBe(true);
    expect(inRangeChunk(8, 0, 8)).toBe(false);
  });
});
