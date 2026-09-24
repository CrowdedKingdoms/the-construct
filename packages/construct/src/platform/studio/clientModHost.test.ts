import { describe, expect, it, vi } from 'vitest';

vi.mock('@crowdedkingdoms/crowdyjs', () => ({
  PlayerCodeBroker: class {},
  CROWDY_DEFAULT_HTTP_ORIGIN: 'http://127.0.0.1:3000',
  CROWDY_DEFAULT_TIER: 'dev',
}));

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
  it('offers world_read plus voxel_set, pointer input, and chunk gameplay', () => {
    expect(OFFERED_HOST_CALLS).toContain('pointer_clicks');
    expect(OFFERED_HOST_CALLS).toContain('pose_set');
    expect(OFFERED_HOST_CALLS).toContain('send_client_event');
    expect(OFFERED_HOST_CALLS).toContain('voice_set');
    expect(OFFERED_HOST_CALLS).toContain('avatar_appearance');
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

  it('refuses a pose outside the grid and returns input axes', async () => {
    const { bindModGrid, bindModInput, releaseModChunk } = await import(
      './modChunkRuntime'
    );
    bindModGrid(grid);
    bindModInput({ axes: () => ({ x: 1, y: 0 }) } as never);
    const { bindModSession } = await import('./modChunkRuntime');
    bindModSession({
      client: {
        udp: { sendClientEvent: async () => true },
        kit: () => ({ inventory: {} }),
      } as never,
      appId: '1',
      gridId: '1',
      selfUuid: 'self',
      userId: '1',
      moveTo: async () => undefined,
      players: () => [{ uuid: 'self', pose: { x: 0, y: 0, z: 0 } }],
      voiceStart: async () => undefined,
      voiceStop: () => undefined,
      videoStart: async () => undefined,
      videoStop: () => undefined,
    });
    const outside = await routeClientHostCall(
      { fn: 'pose_set', args: { x: 1000, y: 0, z: 0 } } as never,
      reads().reads,
      grid,
    );
    expect(outside).toEqual({ ok: false, error: 'outside the player grid' });
    const axes = await routeClientHostCall(
      { fn: 'input_axes', args: {} } as never,
      reads().reads,
      grid,
    );
    expect(axes).toEqual({ x: 1, y: 0 });
    const other = await routeClientHostCall(
      { fn: 'actor_spawn', args: { uuid: 'self', x: 0, y: 0, z: 0 } } as never,
      reads().reads,
      grid,
    );
    expect(other).toEqual({ ok: false, error: 'refusing a live player uuid' });
    const kit = await routeClientHostCall(
      { fn: 'inventory_transfer', args: { targetUuid: 'bob', fromStackId: 'a', toStackId: 'b' } } as never,
      reads().reads,
      grid,
    );
    expect(kit).toEqual({ ok: false, error: 'target is outside the grid' });
    const far = await routeClientHostCall(
      { fn: 'teleport_request', args: { destChunkX: 9, destChunkY: 0, destChunkZ: 0, uuid: 'self' } } as never,
      reads().reads,
      grid,
    );
    expect(far).toEqual({ ok: false, error: 'outside the player grid' });
    const { modProjectiles } = await import('./modChunkRuntime');
    await routeClientHostCall(
      {
        fn: 'send_client_event',
        args: {
          x: 0,
          y: 0,
          z: 0,
          payloadBase64: btoa(
            JSON.stringify({
              kind: 'projectile',
              origin: { x: 1, y: 1.7, z: 2 },
              direction: { x: 0, y: 0, z: -1 },
              speed: 40,
              startMs: 0,
              lifeMs: 1000,
            }),
          ),
        },
      } as never,
      reads().reads,
      grid,
    );
    expect(modProjectiles(0)).toHaveLength(1);
    releaseModChunk();
    bindModInput(null);
  });

  it('decodes an empty grid to no rows', () => {
    expect(voxelsFromBase64(null)).toEqual([]);
    expect(voxelsFromBase64(bytesToBase64(new Uint8Array(4096)))).toEqual([]);
  });
});
