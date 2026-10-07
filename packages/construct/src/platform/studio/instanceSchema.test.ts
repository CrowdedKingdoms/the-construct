import { describe, expect, it } from 'vitest';

import {
  CatalogAssembler,
  MAX_MESHES,
  MAX_NODES,
  MAX_OVERLAY_OBJECTS,
  MAX_VERTS,
  applyPoses,
  composeScene,
  decodePosePacket,
  encodeCatalogChunks,
  encodePosePacket,
  parseOverlayPayload,
  parseSceneCatalog,
  yawPitchQuat,
} from './instanceSchema';

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
    expect(rows[0]).toMatchObject({ id: 'cue', shape: 'sphere', kind: 'sphere', x: 56, z: 56 });
    expect(rows[0]?.sx).toBeCloseTo(0.08);
    expect(rows[0]?.qw).toBeCloseTo(1);
    expect(rows[1]?.x).toBe(48);
    expect(rows[1]?.z).toBe(48);
  });

  it('accepts parent plus quaternion', () => {
    const rows = parseOverlayPayload({
      nodes: [
        { id: 'handle', x: 1, y: 1, z: 1, qx: 0, qy: 0.7071, qz: 0, qw: 0.7071 },
        { id: 'shaft', parent: 'handle', x: 0, y: 0, z: 0.5, kind: 'cylinder' },
      ],
    });
    expect(rows[1]).toMatchObject({ id: 'shaft', parent: 'handle', kind: 'cylinder' });
    expect(rows[0]?.qy).toBeCloseTo(0.7071, 3);
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

describe('parseSceneCatalog', () => {
  it('keeps primitives and a capped procedural mesh', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const catalog = parseSceneCatalog({
      v: 1,
      revision: 4,
      meshes: [{ id: 'tri', kind: 'mesh', positions, indices: [0, 1, 2], color: 0xff0000 }],
      nodes: [{ id: 'cue', mesh: 'tri', x: 1, y: 2, z: 3 }],
    });
    expect(catalog?.revision).toBe(4);
    expect(catalog?.meshes[0]?.positions).toHaveLength(9);
    expect(catalog?.nodes[0]?.mesh).toBe('tri');
  });

  it('drops over-cap vertex lists and parent-less garbage', () => {
    const positions = Array.from({ length: (MAX_VERTS + 1) * 3 }, () => 1);
    expect(
      parseSceneCatalog({
        v: 1,
        meshes: [{ id: 'big', kind: 'mesh', positions, indices: [0, 1, 2] }],
        nodes: [{ id: 'ok', x: 0, y: 0, z: 0 }],
      })?.meshes,
    ).toEqual([]);
  });

  it('caps meshes at MAX_MESHES', () => {
    const meshes = Array.from({ length: MAX_MESHES + 3 }, (_, i) => ({
      id: `m${i}`,
      kind: 'box',
    }));
    expect(parseSceneCatalog({ v: 1, meshes, nodes: [] })?.meshes).toHaveLength(MAX_MESHES);
  });
});

describe('composeScene', () => {
  it('parents a child through a quaternion and clamps to the grid', () => {
    const [qx, qy, qz, qw] = yawPitchQuat(Math.PI / 2, 0);
    const composed = composeScene(
      [
        {
          id: 'root',
          kind: 'box',
          x: 50,
          y: 1,
          z: 50,
          qx,
          qy,
          qz,
          qw,
          sx: 1,
          sy: 1,
          sz: 1,
          color: 1,
          visible: true,
        },
        {
          id: 'child',
          parent: 'root',
          kind: 'box',
          x: 1,
          y: 0,
          z: 0,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          sx: 1,
          sy: 1,
          sz: 1,
          color: 2,
          visible: true,
        },
      ],
      [],
      [],
      grid,
    );
    const child = composed.find((n) => n.id === 'child');
    // +90° yaw (Y): local +X maps to world −Z in the right-handed convention.
    expect(child?.z).toBeCloseTo(49, 1);
    expect(child?.x).toBeCloseTo(50, 1);
  });

  it('drops a parent cycle', () => {
    const composed = composeScene(
      [
        {
          id: 'a',
          parent: 'b',
          kind: 'box',
          x: 0,
          y: 0,
          z: 0,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          sx: 1,
          sy: 1,
          sz: 1,
          color: 1,
          visible: true,
        },
        {
          id: 'b',
          parent: 'a',
          kind: 'box',
          x: 0,
          y: 0,
          z: 0,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          sx: 1,
          sy: 1,
          sz: 1,
          color: 1,
          visible: true,
        },
      ],
      [],
      [],
    );
    expect(composed).toEqual([]);
  });

  it('binds a node to an actor pose', () => {
    const composed = composeScene(
      [
        {
          id: 'cue',
          bindActor: 'player-1',
          kind: 'box',
          x: 0,
          y: 0,
          z: 1,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          sx: 1,
          sy: 1,
          sz: 1,
          color: 1,
          visible: true,
        },
      ],
      [],
      [{ uuid: 'player-1', x: 10, y: 0, z: 10, yaw: 0, pitch: 0 }],
    );
    expect(composed[0]?.z).toBeCloseTo(11);
    expect(composed[0]?.x).toBeCloseTo(10);
  });
});

describe('pose and catalog packets', () => {
  it('round-trips packed poses onto named nodes', () => {
    const nodes = [
      {
        id: 'a',
        kind: 'box' as const,
        x: 1.5,
        y: 2,
        z: 3,
        qx: 0,
        qy: 0.7071,
        qz: 0,
        qw: 0.7071,
        sx: 1,
        sy: 2,
        sz: 1,
        color: 0,
        visible: true,
      },
    ];
    const packet = encodePosePacket(9, nodes);
    const decoded = decodePosePacket(packet, ['a']);
    expect(decoded?.catalogRev).toBe(9);
    const pose = decoded?.poses.get('a');
    expect(pose?.x).toBeCloseTo(1.5);
    expect(pose?.qy).toBeCloseTo(0.7071, 2);
    const applied = applyPoses(
      [{ ...nodes[0]!, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }],
      decoded!.poses,
    );
    expect(applied[0]?.x).toBeCloseTo(1.5);
  });

  it('assembles chunked catalog JSON', () => {
    const json = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        revision: 2,
        meshes: [],
        nodes: [{ id: 'box', kind: 'box', x: 1, y: 1, z: 1 }],
      }),
    );
    const chunks = encodeCatalogChunks(2, json);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const assembler = new CatalogAssembler();
    let joined: Uint8Array | null = null;
    for (const chunk of chunks) joined = assembler.push(chunk);
    expect(joined).not.toBeNull();
    const catalog = parseSceneCatalog(JSON.parse(new TextDecoder().decode(joined!)));
    expect(catalog?.nodes[0]?.id).toBe('box');
  });

  it('exports MAX_NODES as the overlay cap', () => {
    expect(MAX_NODES).toBe(64);
    expect(MAX_MESHES).toBe(16);
  });
});
