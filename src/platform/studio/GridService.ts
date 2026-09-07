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
 *     result is remembered per browser and mirrored into a `Claim` container.
 *  2. The `Claim` containers in the game model: the player-readable registry
 *     of who claimed which chunk. The platform's own grid tables answer
 *     "which grid contains this chunk" only to app admins
 *     (`nearbyGridPermissions` requires manage_apps — measured 2026-09-07), so
 *     visitors learn the grid under their feet from here.
 *  3. `gameApps.nearbyPermissions`, when the caller is an admin, to refresh
 *     the effective keys on an owned grid. Failing that is expected for
 *     ordinary players and is not an error.
 */
import { MODEL_NAMES } from '../../../model/blueprints.mjs';

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
  type PlayerCodePermissionKey,
  type StudioPermissions,
} from '@/platform/studio/permissions';

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
  containerId: string;
  gridId: string;
  chunk: ChunkCoord;
  ownerUserId: string;
  ownerName: string;
}

export class GridService {
  private owned = new Map<string, OwnedRecord>();
  private registry: { at: number; claims: ClaimRecord[] } | null = null;
  private registryInFlight: Promise<ClaimRecord[]> | null = null;

  constructor(private readonly network: NetworkManager) {
    this.loadOwned();
  }

  /** Claim the chunk under `position` as a one-chunk grid owned by the player. */
  async claimHere(chunk: ChunkCoord, ownerName: string): Promise<GridSnapshot> {
    const appId = this.requireAppId();
    const claimed = await this.network.game.marketplace.claimGridChunk({ appId, chunk: chunkInput(chunk) });
    const bounds = gridBoundsFrom(claimed.lowChunk, claimed.highChunk) ?? singleChunkBounds(chunk);
    const permissions = studioPermissions(claimed.effectivePermissionKeys);
    const gridId = String(claimed.gridId);
    this.owned.set(chunkKey(chunk), { gridId, bounds, effectiveKeys: permissions.effectiveKeys });
    this.saveOwned();
    await this.recordClaim(gridId, chunk, ownerName);
    return { gridId, bounds, permissions, owned: true, ownerName, policy: claimed.policy ?? undefined };
  }

  async release(gridId: string): Promise<void> {
    const appId = this.requireAppId();
    await this.network.game.marketplace.releaseClaimedGrid({ appId, gridId });
    for (const [key, record] of this.owned) if (record.gridId === gridId) this.owned.delete(key);
    this.saveOwned();
    const claims = await this.claims(true);
    for (const claim of claims) {
      if (claim.gridId === gridId && claim.ownerUserId === this.network.user?.userId) {
        await this.network.game.gameModel
          .deleteContainer({ appId, containerId: claim.containerId })
          .catch(() => undefined);
      }
    }
    this.registry = null;
  }

  /** The grid at `chunk` as this player may know it, or null for open world. */
  async lookup(chunk: ChunkCoord): Promise<GridSnapshot | null> {
    const mine = this.ownedAt(chunk);
    if (mine) {
      const refreshed = await this.refreshOwnedKeys(chunk, mine);
      // A grid claimed before the registry existed (or from a browser whose
      // registry write failed) gets its row on the next visit.
      const registered = (await this.claims()).some((c) => c.gridId === mine.gridId);
      if (!registered) void this.recordClaim(mine.gridId, chunk, this.ownerNameHint());
      return {
        gridId: mine.gridId,
        bounds: mine.bounds,
        permissions: studioPermissions(refreshed ?? mine.effectiveKeys),
        owned: true,
      };
    }
    const claims = await this.claims();
    const claim = claims.find((c) => chunkKey(c.chunk) === chunkKey(chunk));
    if (!claim) return null;
    const owned = claim.ownerUserId === this.network.user?.userId;
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
    for (const record of this.owned.values()) if (gridBoundsContain(record.bounds, chunk)) return record;
    return null;
  }

  /** Admin-only read; returns the keys when it works, null when it does not. */
  private async refreshOwnedKeys(chunk: ChunkCoord, record: OwnedRecord): Promise<PlayerCodePermissionKey[] | null> {
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

  private async recordClaim(gridId: string, chunk: ChunkCoord, ownerName: string): Promise<void> {
    const appId = this.requireAppId();
    const userId = this.network.user?.userId ?? '0';
    try {
      const existing = (await this.claims(true)).find((c) => c.gridId === gridId);
      if (existing) return;
      await this.network.game.gameModel.createContainer({
        appId,
        typeName: MODEL_NAMES.claimType,
        displayName: `Claim ${gridId}`,
        properties: [
          { key: 'grid_id', valueType: 'string', valueJson: JSON.stringify(gridId) },
          { key: 'cx', valueType: 'int', valueJson: String(chunk.x) },
          { key: 'cy', valueType: 'int', valueJson: String(chunk.y) },
          { key: 'cz', valueType: 'int', valueJson: String(chunk.z) },
          { key: 'owner_user_id', valueType: 'int', valueJson: String(userId) },
          { key: 'owner_name', valueType: 'string', valueJson: JSON.stringify(ownerName.slice(0, 32)) },
        ],
      });
      this.registry = null;
    } catch (error) {
      // The claim itself succeeded; only the registry row failed (model not
      // seeded yet). Say so rather than hide it.
      this.network.log(`claim registry write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The Claim registry, cached briefly (visitors poll it as they walk). */
  private async claims(force = false): Promise<ClaimRecord[]> {
    if (!force && this.registry && Date.now() - this.registry.at < REGISTRY_TTL_MS) return this.registry.claims;
    if (this.registryInFlight) return this.registryInFlight;
    const appId = this.requireAppId();
    this.registryInFlight = (async () => {
      const claims: ClaimRecord[] = [];
      try {
        const rows = await this.network.game.gameModel.containers({ appId, typeName: MODEL_NAMES.claimType, limit: 200 });
        for (const row of rows) {
          const state = await this.network.game.gameModel.containerState({ appId, containerId: row.containerId });
          let props: Record<string, unknown> = {};
          try {
            props = JSON.parse(state.propertiesJson) as Record<string, unknown>;
          } catch {
            props = {};
          }
          const gridId = String(props.grid_id ?? '');
          if (!gridId) continue;
          claims.push({
            containerId: row.containerId,
            gridId,
            chunk: { x: Number(props.cx ?? 0), y: Number(props.cy ?? 0), z: Number(props.cz ?? 0) },
            ownerUserId: String(props.owner_user_id ?? row.ownerUserId ?? ''),
            ownerName: String(props.owner_name ?? ''),
          });
        }
      } catch (error) {
        this.network.log(`claim registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.registry = { at: Date.now(), claims };
      this.registryInFlight = null;
      return claims;
    })();
    return this.registryInFlight;
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
          .map(([k, v]) => [k, { gridId: v.gridId!, bounds: v.bounds!, effectiveKeys: v.effectiveKeys ?? [] }]),
      );
    } catch {
      this.owned = new Map();
    }
  }

  private saveOwned(): void {
    writeScoped(OWNED_KEY, JSON.stringify(Object.fromEntries(this.owned)));
  }
}
