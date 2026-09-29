import { describe, expect, it } from 'vitest';

const {
  DEFAULT_VOXEL_STATE,
  HostCallRefusedError,
  OFFERED_HOST_CALLS,
  bytesToBase64,
  parseVoxelSetArgs,
  routeClientHostCall,
  voxelsFromBase64,
} = await import('./clientModHost');

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

  it('clamps actors_list_radius to the grid', async () => {
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

  it('reads crowdy-client-sdk radii and clamps them as the platform does (3 across, 1 up)', async () => {
    const r = reads();
    const wide = { low: { x: -9n, y: -9n, z: -9n }, high: { x: 9n, y: 9n, z: 9n } };
    await routeClientHostCall(
      {
        fn: 'actors_list_radius',
        args: { x: '0', y: '0', z: '0', radiusXz: 9, radiusY: 4 },
      } as never,
      r.reads,
      wide,
    );
    expect(r.calls.length).toBe(7 * 3 * 7);
    const ys = new Set(r.calls.map((c) => Number(c.split(',')[1])));
    expect([...ys].sort()).toEqual([-1, 0, 1]);
    expect(r.calls.every((c) => Math.abs(Number(c.split(',')[0])) <= 3)).toBe(true);
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
        {
          fn: 'voxel_set',
          args: { chunkX: 0, chunkY: 0, chunkZ: 0, x: 1, y: 0, z: 2, voxelType: 3 },
        } as never,
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

  it('writes no voxel outside the grid, whatever second chunk the call carries', async () => {
    const r = reads();
    const written: Array<{ chunk: { x: number; y: number; z: number } }> = [];
    const writes = {
      setVoxel: async (input: { chunk: { x: number; y: number; z: number } }) => {
        written.push(input);
        return true;
      },
    };
    const voxel = { voxelX: 1, voxelY: 0, voxelZ: 2, voxelType: 7 };
    // The broker checks chunkX/Y/Z against the grid; a call must not steer the write elsewhere.
    for (const args of [
      { chunkX: 0, chunkY: 0, chunkZ: 0, chunk: { x: 999, y: 0, z: 0 }, ...voxel },
      { chunkX: 0, chunkY: 0, chunkZ: 0, chunk: [999, 0, 0], ...voxel },
      { chunkX: 0, chunkY: 0, chunkZ: 0, chunk_x: 999, ...voxel },
    ]) {
      await routeClientHostCall({ fn: 'voxel_set', args } as never, r.reads, grid, writes);
    }
    expect(written.map((w) => w.chunk)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ]);
    // Named only the second way, the chunk is checked against the grid at the write.
    for (const args of [
      { chunk: { x: 999, y: 0, z: 0 }, ...voxel },
      { chunk_x: 5, chunk_y: 0, chunk_z: 0, ...voxel },
      { chunkX: 2, chunkY: 0, chunkZ: 0, ...voxel },
    ]) {
      expect(
        await routeClientHostCall({ fn: 'voxel_set', args } as never, r.reads, grid, writes),
      ).toEqual({ ok: false, error: 'out_of_grid' });
    }
    expect(written.length).toBe(3);
  });

  it('refuses voxel_set without the grid to confine it to', async () => {
    const r = reads();
    await expect(
      routeClientHostCall(
        { fn: 'voxel_set', args: { chunkX: 0, chunkY: 0, chunkZ: 0, voxelType: 1 } } as never,
        r.reads,
        undefined,
        { setVoxel: async () => true },
      ),
    ).rejects.toBeInstanceOf(HostCallRefusedError);
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

  it('parses the voxel_set arguments crowdy-client-sdk sends', () => {
    expect(
      parseVoxelSetArgs({
        chunkX: 3,
        chunkY: 0,
        chunkZ: 3,
        voxelX: 8,
        voxelY: 1,
        voxelZ: 4,
        voxelType: 2,
        stateBase64: null,
      }),
    ).toEqual({
      chunk: { x: 3, y: 0, z: 3 },
      x: 8,
      y: 1,
      z: 4,
      voxelType: 2,
      state: DEFAULT_VOXEL_STATE,
    });
  });

  it('decodes an empty grid to no rows', () => {
    expect(voxelsFromBase64(null)).toEqual([]);
    expect(voxelsFromBase64(bytesToBase64(new Uint8Array(4096)))).toEqual([]);
  });
});
