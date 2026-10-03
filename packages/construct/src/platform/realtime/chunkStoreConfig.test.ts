import { describe, expect, it, vi } from 'vitest';
import { ChunkStore, type ChunkStoreConfig } from '@crowdedkingdoms/crowdyjs/stores';

import { chunkStoreConfig } from './chunkStoreConfig';

const STORED = { x: 3, y: 0, z: 3 };
const NEVER_STORED = { x: 4, y: 0, z: 3 };
const at = (x: number, y: number, z: number) => x + y * 16 + z * 256;

/**
 * What ck-api v2.33.0's `getChunk` returns for a chunk whose dense grid holds one block (5) and
 * whose edit log holds the pool cue mod's felt and white ball (`world.set_voxels`, no state), a
 * painted cell (one byte of state), and that block mined (type 0).
 */
const RECORDED_EDITS = [
  { voxelCoord: { x: 6, y: 1, z: 7 }, voxelType: 1, state: null },
  { voxelCoord: { x: 7, y: 2, z: 8 }, voxelType: 3, state: null },
  { voxelCoord: { x: 8, y: 0, z: 8 }, voxelType: 4, state: 'AA==' },
  { voxelCoord: { x: 2, y: 0, z: 2 }, voxelType: 0, state: null },
];

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The real SDK store over a fake game API that stores only `STORED`. */
function storeWith(config: ChunkStoreConfig) {
  const grid = new Uint8Array(4096);
  grid[at(2, 0, 2)] = 5;
  const coordinates = { x: String(STORED.x), y: String(STORED.y), z: String(STORED.z) };
  const client = {
    chunks: {
      byDistance: vi.fn(async () => ({
        chunks: [{ coordinates, voxels: base64(grid), chunkState: null }],
      })),
      get: vi.fn(async () => ({
        voxels: base64(grid),
        chunkState: null,
        voxelStates: RECORDED_EDITS,
      })),
      update: vi.fn(async () => ({})),
    },
    udp: { sendVoxelUpdate: vi.fn(async () => true) },
  };
  const ctx = {
    appId: '1',
    client,
    ticker: { every: () => () => undefined },
    on: () => () => undefined,
    trackSend: () => undefined,
    setSendTracker: () => undefined,
    onDispose: () => undefined,
  };
  const store = new ChunkStore(ctx as never, { ...config, writeBackIntervalMs: false });
  return { store, client };
}

describe('chunkStoreConfig', () => {
  it("brings back a SERVER mod's blocks, a painted cell and a mined block after a reload", async () => {
    const { store, client } = storeWith(chunkStoreConfig());
    await store.ensureAround(STORED, 1);

    expect(client.chunks.get).toHaveBeenCalledTimes(1);
    expect(client.chunks.get).toHaveBeenCalledWith({
      appId: '1',
      coordinates: { x: '3', y: '0', z: '3' },
    });
    expect(store.get(STORED)?.hydrated).toBe(true);
    expect(store.voxelTypeAt(STORED, 6, 1, 7)).toBe(1);
    expect(store.voxelTypeAt(STORED, 7, 2, 8)).toBe(3);
    expect(store.voxelTypeAt(STORED, 8, 0, 8)).toBe(4);
    expect(store.voxelStateAt(STORED, 8, 0, 8)).toBe('AA==');
    expect(store.voxelTypeAt(STORED, 2, 0, 2)).toBe(0);
  });

  it('shows only the stored grid when the store does not hydrate (the construct before 0.3.6)', async () => {
    const { store, client } = storeWith({ ...chunkStoreConfig(), hydrateVoxelStates: false });
    await store.ensureAround(STORED, 1);

    expect(client.chunks.get).not.toHaveBeenCalled();
    expect(store.voxelTypeAt(STORED, 6, 1, 7)).toBe(0);
    expect(store.voxelTypeAt(STORED, 2, 0, 2)).toBe(5);
  });

  it('seeds a chunk the server never stored, empty and without a write-back', async () => {
    const { store } = storeWith(chunkStoreConfig());
    await store.ensureAround(STORED, 1);

    const seeded = store.get(NEVER_STORED);
    expect(seeded?.loadState).toBe('seeded');
    expect(seeded?.voxels).toEqual(new Uint8Array(4096));
    expect(store.pendingWriteBacks).toBe(0);
  });
});
