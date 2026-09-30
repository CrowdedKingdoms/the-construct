import { describe, expect, it, vi } from 'vitest';
import { ChunkStore } from '@crowdedkingdoms/crowdyjs/stores';

import {
  EXHAUSTED_MESSAGE,
  REFUSED_MESSAGE,
  describeWriteBackFailure,
  guardWriteBacks,
} from './writeBackGuard';

const COORD = { x: 2, y: 0, z: 3 };

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function forbidden(): Error {
  return Object.assign(new Error('You cannot edit this chunk'), {
    extensions: { code: 'FORBIDDEN' },
  });
}

/** The real SDK store over a fake client: `serverVoxels` is the server's copy (null: never stored). */
function storeWith(update: () => Promise<unknown>, serverVoxels: Uint8Array | null) {
  const client = {
    chunks: {
      update: vi.fn(update),
      get: vi.fn(async () =>
        serverVoxels ? { voxels: base64(serverVoxels), voxelStates: [] } : null,
      ),
      byDistance: vi.fn(async () => ({ chunks: [] })),
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
  const store = new ChunkStore(ctx as never, { writeBackIntervalMs: false });
  return { store, client };
}

async function paint(store: ChunkStore, voxelType: number): Promise<void> {
  await store.setVoxel({ chunk: COORD, x: 1, y: 0, z: 1, voxelType, state: 'AA==' });
  store.markDirty(COORD);
}

describe('guardWriteBacks', () => {
  it('undoes a refused paint on a chunk the server never stored, once, and says so', async () => {
    const { store, client } = storeWith(() => Promise.reject(forbidden()), null);
    store.seed(COORD, new Uint8Array(4096), { writeBack: false });
    const notify = vi.fn();
    const off = guardWriteBacks(store, {
      onServer: async () => (await client.chunks.get()) != null,
      notify,
    });

    await paint(store, 5);
    expect(store.voxelTypeAt(COORD, 1, 0, 1)).toBe(5);

    const dropped = await store.flush();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('refused');
    // Sent once, not retried.
    expect(client.chunks.update).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(REFUSED_MESSAGE, 'warn');

    await vi.waitFor(() => expect(store.voxelTypeAt(COORD, 1, 0, 1)).toBe(0));
    expect(store.voxelStateAt(COORD, 1, 0, 1)).toBeUndefined();
    expect(store.get(COORD)?.dirty).toBe(false);
    expect(store.pendingWriteBacks).toBe(0);
    off();
  });

  it("puts a refused chunk back to the server's copy", async () => {
    const server = new Uint8Array(4096);
    server[1 + 256] = 3;
    const { store, client } = storeWith(() => Promise.reject(forbidden()), server);
    store.seed(COORD, server.slice(), { writeBack: false });
    guardWriteBacks(store, {
      onServer: async () => (await client.chunks.get()) != null,
      notify: () => undefined,
    });

    await paint(store, 7);
    await store.flush();

    await vi.waitFor(() => expect(store.voxelTypeAt(COORD, 1, 0, 1)).toBe(3));
  });

  it('says it once for a stroke that drops several chunks', async () => {
    const { store } = storeWith(() => Promise.reject(forbidden()), null);
    let now = 1_000;
    const notify = vi.fn();
    guardWriteBacks(store, { onServer: async () => false, notify, now: () => now });

    for (const x of [0, 1, 2]) {
      const coord = { x, y: 0, z: 0 };
      store.seed(coord, new Uint8Array(4096), { writeBack: false });
      store.markDirty(coord);
    }
    await store.flush();
    expect(notify).toHaveBeenCalledTimes(1);

    now += 5_000;
    store.markDirty({ x: 0, y: 0, z: 0 });
    await store.flush();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('logs the refusal and survives a failed reload', async () => {
    const { store } = storeWith(() => Promise.reject(forbidden()), null);
    store.seed(COORD, new Uint8Array(4096), { writeBack: false });
    const log = vi.fn();
    guardWriteBacks(store, {
      onServer: () => Promise.reject(new Error('offline')),
      notify: () => undefined,
      log,
    });
    await paint(store, 5);
    await store.flush();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('chunk 2,0,3 reload failed: offline'));
    expect(log).toHaveBeenCalledWith(
      'chunk 2,0,3 write-back refused after 1 attempt(s): You cannot edit this chunk',
    );
  });
});

describe('describeWriteBackFailure', () => {
  it('tells a refusal from a server that did not answer', () => {
    expect(describeWriteBackFailure({ reason: 'refused' })).toEqual({
      text: REFUSED_MESSAGE,
      tone: 'warn',
    });
    expect(describeWriteBackFailure({ reason: 'exhausted' })).toEqual({
      text: EXHAUSTED_MESSAGE,
      tone: 'error',
    });
  });
});
