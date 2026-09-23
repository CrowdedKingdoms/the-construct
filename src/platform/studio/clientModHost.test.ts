import { describe, expect, it, vi } from 'vitest';

vi.mock('@crowdedkingdoms/crowdyjs', () => ({ PlayerCodeBroker: class {} }));

const {
  DEFAULT_VOXEL_STATE,
  HostCallRefusedError,
  OFFERED_HOST_CALLS,
  bytesToBase64,
  parseVoxelSetArgs,
  routeClientHostCall,
  voxelStateToWire,
  voxelsFromBase64,
  voxelsListRows,
} = await import('@/platform/studio/clientModHost');

const grid = { low: { x: -1n, y: 0n, z: -1n }, high: { x: 1n, y: 0n, z: 1n } };

function reads() {
  const calls: string[] = [];
  return {
    calls,
    reads: {
      actorsInChunk: (x: bigint, y: bigint, z: bigint) => {
        calls.push(`${x},${y},${z}`);
        return x === 0n && z === 0n ? [{ uuid: 'me', name: 'neo' }] : [];
      },
      chunkVoxels: (x: bigint) => (x === 0n ? { voxelsBase64: bytesToBase64(sampleGrid()) } : null),
    },
  };
}

function sampleGrid(): Uint8Array {
  const g = new Uint8Array(4096);
  g[1 + 0 * 16 + 2 * 256] = 7; // x=1, y=0, z=2
  return g;
}

describe('routeClientHostCall', () => {
  it('offers world_read plus voxel_set and pointer_clicks', () => {
    expect([...OFFERED_HOST_CALLS]).toEqual([
      'actors_list',
      'actors_list_radius',
      'chunk_get',
      'voxels_list',
      'voxel_set',
      'pointer_clicks',
    ]);
  });

  it('answers actors_list for one chunk', async () => {
    const r = reads();
    const out = await routeClientHostCall(
      { fn: 'actors_list', args: { x: '0', y: '0', z: '0' } } as never,
      r.reads,
      grid,
    );
    expect(out).toEqual({ actors: [{ uuid: 'me', name: 'neo' }] });
  });

  it('clamps actors_list_radius to the grid and to radius 8', async () => {
    const r = reads();
    await routeClientHostCall(
      { fn: 'actors_list_radius', args: { x: '0', y: '0', z: '0', radius: 50 } } as never,
      r.reads,
      grid,
    );
    // 3x1x3 chunks inside the grid, never beyond it.
    expect(r.calls.length).toBe(9);
    expect(r.calls.every((c) => c.split(',').every((v) => Math.abs(Number(v)) <= 1))).toBe(true);
  });

  it('serves chunk_get as base64 and voxels_list as sparse rows', async () => {
    const r = reads();
    const dense = (await routeClientHostCall(
      { fn: 'chunk_get', args: { x: 0, y: 0, z: 0 } } as never,
      r.reads,
      grid,
    )) as {
      voxelsBase64: string;
    };
    expect(atob(dense.voxelsBase64).length).toBe(4096);
    const sparse = await routeClientHostCall(
      { fn: 'voxels_list', args: { x: 0, y: 0, z: 0 } } as never,
      r.reads,
      grid,
    );
    expect(sparse).toEqual({ voxels: [{ x: 1, y: 0, z: 2, voxelType: 7 }] });
    expect(
      await routeClientHostCall(
        { fn: 'voxels_list', args: { x: 5, y: 0, z: 0 } } as never,
        r.reads,
        grid,
      ),
    ).toEqual({
      voxels: [],
    });
  });

  it('refuses host calls it does not offer', async () => {
    const r = reads();
    for (const fn of ['model_invoke', 'emit_spatial', 'fetch', 'eval']) {
      await expect(
        routeClientHostCall({ fn, args: {} } as never, r.reads, grid),
      ).rejects.toBeInstanceOf(HostCallRefusedError);
    }
  });

  it('drains pointer_clicks when the game supplies an input sink', async () => {
    const r = reads();
    await expect(
      routeClientHostCall({ fn: 'pointer_clicks', args: {} } as never, r.reads, grid),
    ).rejects.toBeInstanceOf(HostCallRefusedError);
    const snapshot = {
      nowMs: 50,
      buttons: 1,
      holdingMs: { '0': 40 },
      clicks: [{ t: 'down' as const, button: 0, atMs: 10, nx: 0, ny: 0 }],
    };
    expect(
      await routeClientHostCall(
        { fn: 'pointer_clicks', args: {} } as never,
        r.reads,
        grid,
        undefined,
        { drainPointerClicks: () => snapshot },
      ),
    ).toEqual(snapshot);
  });

  it('refuses voxel_set when the game did not supply a write sink', async () => {
    const r = reads();
    await expect(
      routeClientHostCall(
        { fn: 'voxel_set', args: { chunkX: 0, chunkY: 0, chunkZ: 0, x: 1, y: 0, z: 2, voxelType: 3 } } as never,
        r.reads,
        grid,
      ),
    ).rejects.toBeInstanceOf(HostCallRefusedError);
  });

  it('writes a voxel through the Paint-equivalent sink', async () => {
    const r = reads();
    const written: unknown[] = [];
    const out = await routeClientHostCall(
      {
        fn: 'voxel_set',
        args: { chunk: { x: '0', y: '0', z: '0' }, voxel: [1, 0, 2], voxel_type: 7 },
      } as never,
      r.reads,
      grid,
      {
        setVoxel: async (input) => {
          written.push(input);
          return true;
        },
      },
    );
    expect(out).toEqual({ ok: true });
    expect(written).toEqual([
      {
        chunk: { x: 0, y: 0, z: 0 },
        x: 1,
        y: 0,
        z: 2,
        voxelType: 7,
        state: DEFAULT_VOXEL_STATE,
      },
    ]);
  });

  it('parses the SDK voxel_set shape (voxelX/stateBase64)', () => {
    expect(
      parseVoxelSetArgs({
        chunkX: -1,
        chunkY: 0,
        chunkZ: -1,
        voxelX: 4,
        voxelY: 15,
        voxelZ: 15,
        voxelType: 1,
        stateBase64: '{"u":"abc","shot":1}',
      }),
    ).toEqual({
      chunk: { x: -1, y: 0, z: -1 },
      x: 4,
      y: 15,
      z: 15,
      voxelType: 1,
      state: '{"u":"abc","shot":1}',
    });
  });

  it('parses flattened chunkX host-call args the broker clamps', () => {
    expect(
      parseVoxelSetArgs({
        chunkX: 3,
        chunkY: 0,
        chunkZ: 3,
        x: 8,
        y: 1,
        z: 4,
        voxelType: 2,
        state_base64: 'AA==',
      }),
    ).toEqual({
      chunk: { x: 3, y: 0, z: 3 },
      x: 8,
      y: 1,
      z: 4,
      voxelType: 2,
      state: 'AA==',
    });
  });

  it('decodes an empty grid to no rows', () => {
    expect(voxelsFromBase64(null)).toEqual([]);
    expect(voxelsFromBase64(bytesToBase64(new Uint8Array(4096)))).toEqual([]);
  });

  it('attaches sparse voxel state onto voxels_list rows', () => {
    const packed = new Uint8Array(4096);
    packed[2 + 15 * 16 + 0 * 256] = 1;
    const json = '{"players":[{"uuid":"fake1","name":"Alice"}]}';
    expect(voxelStateToWire(json)).toBe(bytesToBase64(new TextEncoder().encode(json)));
    expect(voxelStateToWire('AA==')).toBe('AA==');
    expect(
      voxelsListRows(bytesToBase64(packed), [{ x: 2, y: 15, z: 0, state: json }]),
    ).toEqual([{ x: 2, y: 15, z: 0, voxelType: 1, state: json }]);
  });
});
