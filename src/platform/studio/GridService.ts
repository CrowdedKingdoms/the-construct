/**
 * Which grid is the player standing on, and what may they do there?
 *
 * Grids are the platform's unit of player authority: a claimed chunk becomes
 * a one-chunk grid the player owns, and the access-tier code keys are
 * materialised onto it. Crowdy Studio opens on a grid, never on bare world.
 *
 * Two reads, both authoritative:
 *  - `claimHere` -> `marketplace.claimGridChunk` (SELF_CLAIM policy) returns
 *    the new grid, its bounds and the caller's effective permission keys;
 *  - `lookup`    -> `gameApps.nearbyPermissions` reports the grids overlapping
 *    a chunk with the caller's effective keys on each.
 * Owned grids are also remembered per browser so the HUD can label them before
 * the first read; every real permission check happens server-side regardless.
 */
import type { NetworkManager } from '@/platform/network/NetworkManager';
import { readScoped, writeScoped } from '@/platform/envScope';
import { chunkInput, chunkKey, type ChunkCoord } from '@/platform/realtime/space';
import {
  NO_STUDIO_PERMISSIONS,
  gridBoundsContain,
  gridBoundsFrom,
  singleChunkBounds,
  studioPermissions,
  type GridBounds,
  type StudioPermissions,
} from '@/platform/studio/permissions';

export interface GridSnapshot {
  gridId: string;
  bounds: GridBounds;
  permissions: StudioPermissions;
  /** Claimed by this player from this browser (label only). */
  owned: boolean;
  policy?: string;
}

const OWNED_KEY = 'construct:owned-grids';

interface OwnedRecord {
  gridId: string;
  bounds: GridBounds;
}

export class GridService {
  private owned = new Map<string, OwnedRecord>();

  constructor(private readonly network: NetworkManager) {
    this.loadOwned();
  }

  /** Claim the chunk under `position` as a one-chunk grid owned by the player. */
  async claimHere(chunk: ChunkCoord): Promise<GridSnapshot> {
    const appId = this.requireAppId();
    const claimed = await this.network.game.marketplace.claimGridChunk({
      appId,
      chunk: chunkInput(chunk),
    });
    const bounds = gridBoundsFrom(claimed.lowChunk, claimed.highChunk) ?? singleChunkBounds(chunk);
    const snapshot: GridSnapshot = {
      gridId: String(claimed.gridId),
      bounds,
      permissions: studioPermissions(claimed.effectivePermissionKeys),
      owned: true,
      policy: claimed.policy ?? undefined,
    };
    this.owned.set(chunkKey(chunk), { gridId: snapshot.gridId, bounds });
    this.saveOwned();
    return snapshot;
  }

  async release(gridId: string): Promise<void> {
    const appId = this.requireAppId();
    await this.network.game.marketplace.releaseClaimedGrid({ appId, gridId });
    for (const [key, record] of this.owned) if (record.gridId === gridId) this.owned.delete(key);
    this.saveOwned();
  }

  /** The grid overlapping `chunk` with this player's effective keys, if any. */
  async lookup(chunk: ChunkCoord): Promise<GridSnapshot | null> {
    const appId = this.requireAppId();
    const userId = this.network.user?.userId;
    if (!userId) return null;
    let rows: Array<{
      gridId?: unknown;
      lowChunk?: unknown;
      highChunk?: unknown;
      permissionKeys?: unknown;
    }>;
    try {
      rows = (await this.network.game.gameApps.nearbyPermissions({
        appId,
        userId,
        lowChunk: chunkInput(chunk),
        highChunk: chunkInput(chunk),
      })) as typeof rows;
    } catch (error) {
      this.network.log(`nearbyPermissions failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.ownedAt(chunk);
    }
    const containing = rows.find((row) => {
      const bounds = gridBoundsFrom(row.lowChunk, row.highChunk);
      return bounds ? gridBoundsContain(bounds, chunk) : false;
    });
    const row = containing ?? rows[0];
    if (!row) return null;
    const gridId = String(row.gridId ?? '');
    if (!gridId) return null;
    const bounds = gridBoundsFrom(row.lowChunk, row.highChunk) ?? singleChunkBounds(chunk);
    const keys = Array.isArray(row.permissionKeys) ? row.permissionKeys : [];
    return {
      gridId,
      bounds,
      permissions: keys.length ? studioPermissions(keys) : NO_STUDIO_PERMISSIONS,
      owned: [...this.owned.values()].some((o) => o.gridId === gridId),
    };
  }

  ownedAt(chunk: ChunkCoord): GridSnapshot | null {
    for (const record of this.owned.values()) {
      if (gridBoundsContain(record.bounds, chunk)) {
        return { gridId: record.gridId, bounds: record.bounds, permissions: NO_STUDIO_PERMISSIONS, owned: true };
      }
    }
    return null;
  }

  ownedGrids(): OwnedRecord[] {
    return [...this.owned.values()];
  }

  private requireAppId(): string {
    const appId = this.network.appId;
    if (!appId) throw new Error('Enter an app before using grids');
    return appId;
  }

  private loadOwned(): void {
    const raw = readScoped(OWNED_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, OwnedRecord>;
      this.owned = new Map(Object.entries(parsed));
    } catch {
      this.owned = new Map();
    }
  }

  private saveOwned(): void {
    writeScoped(OWNED_KEY, JSON.stringify(Object.fromEntries(this.owned)));
  }
}
