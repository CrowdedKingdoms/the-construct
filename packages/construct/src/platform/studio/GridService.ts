/**
 * Which grid is the player standing on, and what may they do there?
 *
 * Grids are the platform's unit of player authority: a claimed chunk becomes
 * a one-chunk grid the player owns, and the access-tier code keys are
 * materialised onto it. Crowdy Studio opens on a grid, never on bare world.
 *
 * Three sources, in order of authority:
 *  1. `claimHere` -> `marketplace.claimGridChunk` (SELF_CLAIM policy): the
 *     new grid, its bounds and the caller's EFFECTIVE permission keys. The
 *     result is remembered per browser and recorded in the world hub.
 *  2. The world hub's claim registry (ck-exec, `record_claim` / `claims` /
 *     `release_claim`): the player-readable record of who claimed which chunk.
 *     The platform's own grid tables answer "which grid contains this chunk"
 *     only to app admins (`nearbyGridPermissions` requires manage_apps —
 *     measured 2026-09-07), so visitors learn the grid under their feet from
 *     here. The hub records a claim for the calling player and lets only that
 *     player release it.
 *  3. `gameApps.nearbyPermissions`, when the caller is an admin, to refresh
 *     the effective keys on an owned grid. Failing that is expected for
 *     ordinary players and is not an error.
 */
import { messageOf, type NetworkManager } from '../network/NetworkManager';
import { readScoped, writeScoped } from '../envScope';
import { chunkInput, chunkKey, type ChunkCoord } from '../realtime/space';
import {
  NO_STUDIO_PERMISSIONS,
  gridBoundsContain,
  gridBoundsFrom,
  singleChunkBounds,
  studioPermissions,
  type GridBounds,
  type PlayerCodePermissionKey,
  type StudioPermissions,
} from './permissions';

export interface GridSnapshot {
  gridId: string;
  bounds: GridBounds;
  permissions: StudioPermissions;
  /** Claimed by this player (from the registry or this browser). */
  owned: boolean;
  ownerName?: string;
  policy?: string;
}

const OWNED_KEY = 'construct:owned-grids';
const REGISTRY_TTL_MS = 10_000;

interface OwnedRecord {
  gridId: string;
  bounds: GridBounds;
  effectiveKeys: PlayerCodePermissionKey[];
}

interface ClaimRecord {
  gridId: string;
  chunk: ChunkCoord;
  ownerUserId: string;
  ownerName: string;
}

/** A claim as the world hub lists it. */
interface HubClaim {
  gridId: string;
  chunk: ChunkCoord;
  ownerUserId: string;
  ownerName: string;
}

export class GridService {
  private owned = new Map<string, OwnedRecord>();
  /** The registry's answer per chunk, cached briefly (visitors poll it as they walk). */
  private registry = new Map<string, { at: number; claim: ClaimRecord | null }>();
  private registryInFlight = new Map<string, Promise<ClaimRecord | null>>();
  /** Grids this session already tried to put in the registry from `lookup`. */
  private backfilled = new Set<string>();

  constructor(private readonly network: NetworkManager) {
    this.loadOwned();
  }

  private get hub() {
    return this.network.worldHub;
  }

  /** Claim the chunk under `position` as a one-chunk grid owned by the player. */
  async claimHere(chunk: ChunkCoord, ownerName: string): Promise<GridSnapshot> {
    const appId = this.requireAppId();
    const claimed = await this.network.game.marketplace.claimGridChunk({
      appId,
      chunk: chunkInput(chunk),
    });
    const bounds = gridBoundsFrom(claimed.lowChunk, claimed.highChunk) ?? singleChunkBounds(chunk);
    const permissions = studioPermissions(claimed.effectivePermissionKeys);
    const gridId = String(claimed.gridId);
    this.owned.set(chunkKey(chunk), { gridId, bounds, effectiveKeys: permissions.effectiveKeys });
    this.saveOwned();
    await this.recordClaim(gridId, chunk, ownerName);
    return {
      gridId,
      bounds,
      permissions,
      owned: true,
      ownerName,
      policy: claimed.policy ?? undefined,
    };
  }

  async release(gridId: string): Promise<void> {
    const appId = this.requireAppId();
    await this.network.game.marketplace.releaseClaimedGrid({ appId, gridId });
    for (const [key, record] of this.owned) if (record.gridId === gridId) this.owned.delete(key);
    this.saveOwned();
    try {
      await this.hub.call('release_claim', { gridId });
    } catch (error) {
      this.network.log(`claim registry release failed: ${messageOf(error)}`);
    }
    this.registry.clear();
  }

  /** The grid at `chunk` as this player may know it, or null for open world. */
  async lookup(chunk: ChunkCoord): Promise<GridSnapshot | null> {
    const mine = this.ownedAt(chunk);
    if (mine) {
      const refreshed = await this.refreshOwnedKeys(chunk, mine);
      // A grid claimed before the registry existed (or from a browser whose registry write
      // failed) gets its row on the next visit.
      const registered = await this.claimAt(chunk);
      if (registered?.gridId !== mine.gridId && !this.backfilled.has(mine.gridId)) {
        this.backfilled.add(mine.gridId);
        void this.recordClaim(mine.gridId, chunk, this.ownerNameHint());
      }
      return {
        gridId: mine.gridId,
        bounds: mine.bounds,
        permissions: studioPermissions(refreshed ?? mine.effectiveKeys),
        owned: true,
      };
    }
    const claim = await this.claimAt(chunk);
    if (!claim) return null;
    const owned = claim.ownerUserId === this.network.user?.userId;
    if (owned) {
      const record: OwnedRecord = {
        gridId: claim.gridId,
        bounds: singleChunkBounds(chunk),
        effectiveKeys: [],
      };
      const refreshed = await this.refreshOwnedKeys(chunk, record);
      if (refreshed && refreshed.length > 0) {
        this.owned.set(chunkKey(chunk), { ...record, effectiveKeys: refreshed });
        this.saveOwned();
        return {
          gridId: claim.gridId,
          bounds: record.bounds,
          permissions: studioPermissions(refreshed),
          owned: true,
          ownerName: claim.ownerName,
        };
      }
    }
    return {
      gridId: claim.gridId,
      bounds: singleChunkBounds(chunk),
      permissions: NO_STUDIO_PERMISSIONS,
      owned,
      ownerName: claim.ownerName,
    };
  }

  ownedGrids(): OwnedRecord[] {
    return [...this.owned.values()];
  }

  // ---------------------------------------------------------------------------

  private ownedAt(chunk: ChunkCoord): OwnedRecord | null {
    const direct = this.owned.get(chunkKey(chunk));
    if (direct) return direct;
    for (const record of this.owned.values())
      if (gridBoundsContain(record.bounds, chunk)) return record;
    return null;
  }

  /** Admin-only read; returns the keys when it works, null when it does not. */
  private async refreshOwnedKeys(
    chunk: ChunkCoord,
    record: OwnedRecord,
  ): Promise<PlayerCodePermissionKey[] | null> {
    const userId = this.network.user?.userId;
    if (!userId) return null;
    try {
      const rows = (await this.network.game.gameApps.nearbyPermissions({
        appId: this.requireAppId(),
        userId,
        lowChunk: chunkInput(chunk),
        highChunk: chunkInput(chunk),
      })) as Array<{ gridId?: unknown; permissionKeys?: unknown }>;
      const row = rows.find((r) => String(r.gridId) === record.gridId);
      if (!row || !Array.isArray(row.permissionKeys)) return null;
      const keys = studioPermissions(row.permissionKeys).effectiveKeys;
      if (keys.join() !== record.effectiveKeys.join()) {
        record.effectiveKeys = keys;
        this.saveOwned();
      }
      return keys;
    } catch {
      return null; // not an admin: the claim-time keys stand
    }
  }

  /** Records the claim for the signed-in player; the hub takes the owner from the caller. */
  private async recordClaim(gridId: string, chunk: ChunkCoord, ownerName: string): Promise<void> {
    try {
      await this.hub.call('record_claim', {
        gridId,
        chunk: { x: chunk.x, y: chunk.y, z: chunk.z },
        ownerName: ownerName.slice(0, 32),
      });
    } catch (error) {
      // The claim itself succeeded; only the registry row failed (the world hub is not
      // deployed, or another player's claim covers the chunk). Say so rather than hide it.
      this.network.log(`claim registry write failed: ${messageOf(error)}`);
    }
    this.registry.delete(chunkKey(chunk));
  }

  /** The registry's claim at `chunk`, or null; a failed read counts as none until it expires. */
  private claimAt(chunk: ChunkCoord): Promise<ClaimRecord | null> {
    const key = chunkKey(chunk);
    const cached = this.registry.get(key);
    if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return Promise.resolve(cached.claim);
    const inFlight = this.registryInFlight.get(key);
    if (inFlight) return inFlight;
    const read = (async () => {
      let claim: ClaimRecord | null = null;
      try {
        const { claims } = await this.hub.call<{ claims: HubClaim[] }>('claims', {
          chunk: { x: chunk.x, y: chunk.y, z: chunk.z },
        });
        const row = claims[0];
        if (row) {
          claim = {
            gridId: String(row.gridId),
            chunk: { x: Number(row.chunk.x), y: Number(row.chunk.y), z: Number(row.chunk.z) },
            ownerUserId: String(row.ownerUserId),
            ownerName: String(row.ownerName ?? ''),
          };
        }
      } catch (error) {
        this.network.log(`claim registry unavailable: ${messageOf(error)}`);
      }
      this.registry.set(key, { at: Date.now(), claim });
      this.registryInFlight.delete(key);
      return claim;
    })();
    this.registryInFlight.set(key, read);
    return read;
  }

  private ownerNameHint(): string {
    const user = this.network.user;
    return (user?.gamertag || user?.email?.split('@')[0] || 'player').slice(0, 32);
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
      const parsed = JSON.parse(raw) as Record<string, Partial<OwnedRecord>>;
      this.owned = new Map(
        Object.entries(parsed)
          .filter(([, v]) => v.gridId && v.bounds)
          .map(([k, v]) => [
            k,
            { gridId: v.gridId!, bounds: v.bounds!, effectiveKeys: v.effectiveKeys ?? [] },
          ]),
      );
    } catch {
      this.owned = new Map();
    }
  }

  private saveOwned(): void {
    writeScoped(OWNED_KEY, JSON.stringify(Object.fromEntries(this.owned)));
  }
}
