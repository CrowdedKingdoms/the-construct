import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  ClaimedChunkLayer,
  claimedChunkAabb,
  claimedChunkBoxTransform,
  claimedChunksToDraw,
} from '@/scenes/holodeck-three/claimedChunkBox';

describe('claimedChunkAabb', () => {
  it('maps a one-chunk grid to a 16-unit world cube', () => {
    expect(
      claimedChunkAabb({
        low: { x: '-1', y: '0', z: '-1' },
        high: { x: '-1', y: '0', z: '-1' },
      }),
    ).toEqual({
      minX: -16,
      maxX: 0,
      minY: 0,
      maxY: 16,
      minZ: -16,
      maxZ: 0,
    });
  });
});

describe('claimedChunkBoxTransform', () => {
  it('centres the mesh on the AABB and lifts the floor edge', () => {
    const t = claimedChunkBoxTransform({
      minX: -16,
      maxX: 0,
      minY: 0,
      maxY: 16,
      minZ: -16,
      maxZ: 0,
    });
    expect(t.x).toBe(-8);
    expect(t.z).toBe(-8);
    expect(t.sx).toBe(16);
    expect(t.sz).toBe(16);
    expect(t.sy).toBeCloseTo(15.95);
    expect(t.y).toBeCloseTo(0.05 + 15.95 / 2);
  });
});

describe('claimedChunksToDraw', () => {
  const bounds = {
    low: { x: '-1', y: '0', z: '-1' },
    high: { x: '-1', y: '0', z: '-1' },
  };

  it('includes owned grids even when the player is standing elsewhere', () => {
    const drawn = claimedChunksToDraw({
      grid: {
        gridId: 'visitor',
        bounds: { low: { x: '0', y: '0', z: '0' }, high: { x: '0', y: '0', z: '0' } },
        owned: false,
      },
      grids: {
        ownedGrids: () => [{ gridId: '91159989710848', bounds }],
      },
    });
    expect(drawn).toEqual([{ gridId: '91159989710848', bounds }]);
  });

  it('outlines the standing grid when it is owned and not yet in the local map', () => {
    const drawn = claimedChunksToDraw({
      grid: { gridId: '91159989710848', bounds, owned: true },
      grids: { ownedGrids: () => [] },
    });
    expect(drawn).toEqual([{ gridId: '91159989710848', bounds }]);
  });
});

describe('claimed chunk shell', () => {
  it('draws outward faces so the interior is open and the outside is solid', () => {
    const scene = new THREE.Scene();
    const layer = new ClaimedChunkLayer(scene);
    const bounds = {
      low: { x: '-4', y: '0', z: '-4' },
      high: { x: '-1', y: '0', z: '-1' },
    };
    layer.sync([{ gridId: '91159989710848', bounds }]);
    const chunk = scene.getObjectByName('claimed-chunk:91159989710848') as THREE.Group;
    const shell = chunk.children[0] as THREE.Mesh;
    const material = shell.material as THREE.MeshBasicMaterial;
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.depthWrite).toBe(true);
    expect(shell.scale.x).toBe(64);
    expect(shell.scale.z).toBe(64);
    layer.dispose();
  });
});

describe('holodeck stays free of a mod avatar', () => {
  it('does not name a robot, a hull, or a range chunk', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = [
      readFileSync(join(here, 'HolodeckScene.ts'), 'utf8'),
      readFileSync(join(here, 'avatars.ts'), 'utf8'),
      readFileSync(join(here, '../../../packages/construct/src/engine/controls.ts'), 'utf8'),
    ].join('\n');
    expect(text).not.toMatch(/robot|shipHull|RANGE_CHUNK|chunkFlight/i);
  });
});
