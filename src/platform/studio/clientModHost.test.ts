import { describe, expect, it, vi } from 'vitest';

vi.mock('@crowdedkingdoms/crowdyjs', () => ({ PlayerCodeBroker: class {} }));

const {
  HostCallRefusedError,
  OFFERED_HOST_CALLS,
  bytesToBase64,
  routeClientHostCall,
  voxelsFromBase64,
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
  it('offers exactly the world_read family', () => {
    expect([...OFFERED_HOST_CALLS]).toEqual([
      'actors_list',
      'actors_list_radius',
      'chunk_get',
      'voxels_list',
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

  it('refuses everything it does not offer', async () => {
    const r = reads();
    for (const fn of ['voxel_set', 'model_invoke', 'emit_spatial', 'fetch', 'eval']) {
      await expect(
        routeClientHostCall({ fn, args: {} } as never, r.reads, grid),
      ).rejects.toBeInstanceOf(HostCallRefusedError);
    }
  });

  it('decodes an empty grid to no rows', () => {
    expect(voxelsFromBase64(null)).toEqual([]);
    expect(voxelsFromBase64(bytesToBase64(new Uint8Array(4096)))).toEqual([]);
  });
});
