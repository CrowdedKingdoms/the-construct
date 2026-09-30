/**
 * What the game does when a chunk write-back is dropped.
 *
 * `ChunkStore` applies a voxel edit locally at once and saves the chunk later
 * (`markDirty` -> `chunks.update`). The server refuses that save for a player
 * without edit permission on the chunk (another player's claim, a safe zone, a
 * closed wilderness); the store sends a refusal once, retries anything else a
 * few times, then drops it and reports it through `onWriteBackFailed`. It does
 * not undo the local edit, so without this the player keeps seeing blocks
 * nobody else has and that are gone on the next load.
 *
 * The guard puts the chunk back to the server's copy and tells the player.
 * Paint, the holodeck and CLIENT `voxel_set` all write through the one store,
 * and `flush()` reports what it dropped through the same listener, so one guard
 * per world session covers every path.
 */
import { CHUNK_VOLUME, type ChunkWriteBackFailure } from '@crowdedkingdoms/crowdyjs/stores';

import type { ChunkCoord } from './space';

/** One stroke across a refused plot drops several chunks; say it once. */
const NOTIFY_QUIET_MS = 4_000;

export type WriteBackTone = 'info' | 'warn' | 'error';

/** The slice of `ChunkStore` the guard uses. */
export interface GuardedChunkStore {
  onWriteBackFailed(
    listener: (failure: ChunkWriteBackFailure<unknown, unknown>) => void,
  ): () => void;
  get(coord: ChunkCoord): { voxelStates: Map<number, unknown> } | undefined;
  hydrate(coord: ChunkCoord): Promise<void>;
  seed(coord: ChunkCoord, voxels: Uint8Array, options?: { writeBack?: boolean }): void;
}

export interface WriteBackGuardOptions {
  /** Whether the server stores the chunk (`client.chunks.get` is not null). */
  onServer(coord: ChunkCoord): Promise<boolean>;
  notify(text: string, tone: WriteBackTone): void;
  log?(message: string): void;
  now?(): number;
}

export const REFUSED_MESSAGE =
  "You can't build here: this area is someone else's claim or a protected zone. Your change was undone.";
export const EXHAUSTED_MESSAGE =
  "Your change couldn't be saved (the server didn't answer), so it was undone. Try again in a moment.";

/** The player-facing line for a dropped write-back. */
export function describeWriteBackFailure(failure: Pick<ChunkWriteBackFailure, 'reason'>): {
  text: string;
  tone: WriteBackTone;
} {
  return failure.reason === 'refused'
    ? { text: REFUSED_MESSAGE, tone: 'warn' }
    : { text: EXHAUSTED_MESSAGE, tone: 'error' };
}

/**
 * Put a chunk back to the server's copy: hydrate it when the server stores it,
 * else back to the empty chunk The Construct seeds for a never-written one.
 */
export async function reloadChunk(
  chunks: GuardedChunkStore,
  coord: ChunkCoord,
  onServer: (coord: ChunkCoord) => Promise<boolean>,
): Promise<void> {
  const stored = await onServer(coord);
  chunks.get(coord)?.voxelStates.clear();
  if (stored) await chunks.hydrate(coord);
  else chunks.seed(coord, new Uint8Array(CHUNK_VOLUME), { writeBack: false });
}

/** Undo and report every write-back the store drops. @returns off. */
export function guardWriteBacks(
  chunks: GuardedChunkStore,
  options: WriteBackGuardOptions,
): () => void {
  const now = options.now ?? (() => Date.now());
  let lastText = '';
  let lastAt = -Infinity;
  return chunks.onWriteBackFailed((failure) => {
    const { coord } = failure;
    const where = `${coord.x},${coord.y},${coord.z}`;
    options.log?.(
      `chunk ${where} write-back ${failure.reason} after ${failure.attempts} attempt(s): ${errorText(failure.error)}`,
    );
    const { text, tone } = describeWriteBackFailure(failure);
    const at = now();
    if (text !== lastText || at - lastAt >= NOTIFY_QUIET_MS) options.notify(text, tone);
    lastText = text;
    lastAt = at;
    void reloadChunk(chunks, coord, options.onServer).catch((error) =>
      options.log?.(`chunk ${where} reload failed: ${errorText(error)}`),
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
