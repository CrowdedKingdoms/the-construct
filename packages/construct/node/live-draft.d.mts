import type { Plugin } from 'vite';

/** A file of the bound repository the game editor may list and write (the CrowdyJS policy). */
export function isRepoPath(filePath: string): boolean;
/** Git's blob id for these bytes. */
export function gitBlobSha(bytes: Uint8Array): string;

/**
 * The dev-server backend of Crowdy Studio's game editor: the checkout is the
 * draft. Does nothing unless `enabled` (default: `LIVE_DRAFT=1`); answers this
 * machine only unless `allowRemote` (default: `LIVE_DRAFT_REMOTE=1`).
 */
export function liveDraftPlugin(options?: {
  root?: string;
  enabled?: boolean;
  allowRemote?: boolean;
}): Plugin;
