/**
 * Crowdy Studio, embedded — the in-game IDE where players write SERVER and
 * CLIENT Rust mods for the grid they stand on.
 *
 * The SDK's embed kit owns the chrome (dock, fullscreen fallback, Context
 * drawer, focus trap, HUD sink). This service supplies what only the game
 * knows:
 *  - the grid the player is on and their effective permissions on it,
 *  - the same-origin glue worker that runs CLIENT mods,
 *  - the allowlisted host-call router (what a mod may read),
 *  - input suppression and layout hooks, and
 *  - the visitor lifecycle: when you stand on someone else's grid, their
 *    trusted CLIENT mods run for you after you approve them.
 *
 * CLIENT mods need `crossOriginIsolated` (COOP + COEP headers on the host). The
 * service checks that at construction and hides the CLIENT half when it is
 * missing, saying so in the HUD, rather than letting a worker fail silently.
 */
import type { PlayerCodeHostCall } from '@crowdedkingdoms/crowdyjs';
import {
  CrowdyStudioEmbed,
  CrowdyStudioTextHud,
  type CrowdyStudioEmbedContext,
} from '@crowdedkingdoms/crowdyjs/crowdy-studio';
import glueWorkerAssetUrl from '@crowdedkingdoms/crowdyjs/player-glue-worker?worker&url';

import { CLIENT_MODS_ENABLED, GAME_NAME } from '@/platform/config';
import type { GameSession } from '@/platform/GameSession';
import { messageOf } from '@/platform/network/NetworkManager';
import { chunkKey, worldToChunk, type ChunkCoord, type Vec3 } from '@/platform/realtime/space';
import { ClientModLifecycle, type ClientModScope } from '@/platform/studio/ClientModLifecycle';
import {
  bytesToBase64,
  routeClientHostCall,
  runConsentedGridMod,
  type ClientModHostReads,
} from '@/platform/studio/clientModHost';
import { GridService, type GridSnapshot } from '@/platform/studio/GridService';
import { hasAnyStudioPermission, toBrokerBounds } from '@/platform/studio/permissions';
import { Emitter } from '@/platform/util/Emitter';

export interface StudioState {
  open: boolean;
  grid: GridSnapshot | null;
  /** COOP/COEP present and the build flag on. */
  clientModsAvailable: boolean;
  clientModsRunning: number;
  /** Why CLIENT mods are unavailable, when they are. */
  clientModsReason: string | null;
}

export interface StudioHooks {
  suppressGameplayInput(): () => void;
  onLayoutChange(rightInsetPx: number): void;
  notify(text: string, tone?: 'info' | 'warn' | 'error'): void;
  /** Ask the player whether to trust an author's mods; defaults to `confirm`. */
  confirmTrust?(summary: string): Promise<boolean>;
}

const GRID_REFRESH_MS = 8_000;
const MODS_REFRESH_MS = 10_000;
/**
 * Presence is written by Buddy when the actor's chunk changes; the trust and
 * artifact gates check it server-side. Asking within the first seconds of
 * entering a grid races that write ("Grid author bundle not found" on
 * 2026-09-07), so wait a moment before the first sync.
 */
const GRID_SETTLE_MS = 4_000;

export class StudioService {
  readonly events = new Emitter<{ state: StudioState }>();
  readonly grids: GridService;
  private readonly hud = new CrowdyStudioTextHud();
  private readonly lifecycle = new ClientModLifecycle();
  private readonly declinedAuthors = new Set<string>();
  private readonly approvedAuthors = new Set<string>();
  private gridEnteredAt = 0;
  private embed: CrowdyStudioEmbed | null = null;
  private hooks: StudioHooks | null = null;
  private state: StudioState;
  private currentGrid: GridSnapshot | null = null;
  private lastGridChunkKey: string | null = null;
  private lastGridReadAt = 0;
  private lastModsReadAt = 0;
  private modsInFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly session: GameSession) {
    this.grids = new GridService(session.network);
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    this.state = {
      open: false,
      grid: null,
      clientModsAvailable: CLIENT_MODS_ENABLED && isolated,
      clientModsRunning: 0,
      clientModsReason: !CLIENT_MODS_ENABLED
        ? 'CLIENT mods are disabled in this build (VITE_CONSTRUCT_CLIENT_MODS=0).'
        : isolated
          ? null
          : 'CLIENT mods are off: this page is not cross-origin isolated. The host must send ' +
            'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless ' +
            '(see docs/HOSTING.md).',
    };
  }

  /** Wire the engine-side hooks; call once after the loop exists. */
  attach(hooks: StudioHooks): void {
    this.hooks = hooks;
    this.embed = new CrowdyStudioEmbed({
      // Resolved lazily: the game client exists only after enterApp, and is
      // rebuilt if the player switches apps.
      client: {
        get crowdyStudio() {
          return network().game.crowdyStudio;
        },
        get playerCompute() {
          return network().game.playerCompute;
        },
        get playerWallet() {
          return network().game.playerWallet;
        },
        // Deliberately no `crowdyStudioAgent`: the agent dock needs a platform
        // policy only an operator can arm, and a `playerHost` adapter this
        // game does not implement. Omitting it keeps the agent hidden/fail-closed.
        //
        // Deliberately no `crowdyStudioGitHub` and no embed `github:`:
        // crowdyStudioGitHub* requires an identity session. This page holds
        // only a play app-token from hosted sign-in (AGENTS.md). Passing the
        // game client would SCOPE_MISSING and show a broken GitHub card. The
        // same `github:` identity-session pattern as BWF cannot land until
        // this origin can hold a session — not Construct PR #42 (agent
        // dock; still app-token), not `npm run setup` (Node identity, not
        // the browser). Author Studio is out of scope. Mod Studio stays on
        // `crowdyStudio` + `playerCompute`.
      },
      appId: () => this.session.appId,
      gameName: GAME_NAME,
      closeKeyCode: 'KeyM',
      suppressGameplayInput: () => hooks.suppressGameplayInput(),
      onLayoutChange: () => hooks.onLayoutChange(this.readRightInset()),
      onClosed: () => this.setOpen(false),
    });
    const network = () => this.session.network;
    if (!this.timer) this.timer = setInterval(() => void this.poll(), 2000);
    this.emit();
  }

  get snapshot(): StudioState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.embed?.open ?? false;
  }

  /** Claim the chunk under `position`, then open the studio on it. */
  async claimHereAndOpen(position: Vec3): Promise<GridSnapshot> {
    const chunk = worldToChunk(position);
    this.hooks?.notify('Claiming this chunk…');
    const grid = await this.grids.claimHere(chunk, this.session.displayName);
    this.adoptGrid(grid, chunk);
    if (!hasAnyStudioPermission(grid.permissions)) {
      throw new Error(
        `Claimed grid ${grid.gridId}, but your access tier grants no code permissions. ` +
          'Re-run Setup (it creates a Constructor tier with the code keys) or grant them in CK Studio.',
      );
    }
    this.hooks?.notify(`Claimed grid ${grid.gridId}. Opening Crowdy Studio…`);
    this.openOn(grid);
    return grid;
  }

  /** M key: toggle the studio on the grid under the player, if permitted. */
  async toggle(position: Vec3): Promise<void> {
    if (!this.embed) return;
    if (this.embed.open) {
      this.embed.close();
      return;
    }
    const chunk = worldToChunk(position);
    let grid =
      this.currentGrid && chunkKey(chunk) === this.lastGridChunkKey ? this.currentGrid : null;
    if (!grid) {
      grid = await this.grids.lookup(chunk);
      this.adoptGrid(grid, chunk);
    }
    if (!grid || !hasAnyStudioPermission(grid.permissions)) {
      this.hooks?.notify(
        grid
          ? 'You have no code permission on this grid. Stand on your own claimed chunk.'
          : 'Stand on a claimed chunk (use the Claim pad) to open Crowdy Studio.',
        'warn',
      );
      return;
    }
    this.openOn(grid);
  }

  close(): void {
    this.embed?.close();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lifecycle.shutdown();
    this.embed?.destroy();
    this.embed = null;
    this.hud.destroy();
  }

  // ---------------------------------------------------------------------------

  private openOn(grid: GridSnapshot): void {
    if (!this.embed) throw new Error('Studio not attached');
    this.embed.toggle(this.contextFor(grid));
    this.setOpen(true);
  }

  private contextFor(grid: GridSnapshot): CrowdyStudioEmbedContext {
    const bounds = toBrokerBounds(grid.bounds);
    const clientOk = this.state.clientModsAvailable;
    const reads = this.reads();
    return {
      gridId: grid.gridId,
      grid: bounds,
      targetPermissions: {
        SERVER: grid.permissions.server,
        // Keys say what you MAY do; isolation says what the browser CAN do.
        CLIENT: clientOk
          ? grid.permissions.client
          : { canWrite: grid.permissions.client.canWrite, canRun: false },
      },
      permissionsNote: clientOk
        ? 'Authoritative effective grid keys'
        : `Authoritative effective grid keys. ${this.state.clientModsReason ?? ''}`.trim(),
      ...(clientOk
        ? {
            workerUrl: glueWorkerAssetUrl,
            onHostCall: (call: PlayerCodeHostCall) => routeClientHostCall(call, reads, bounds),
            hud: this.hud,
          }
        : {}),
    };
  }

  /**
   * What a CLIENT mod may read: players in a chunk (from the replicated lane
   * plus ourselves) and the cached voxel grid of a chunk. Nothing else.
   */
  private reads(): ClientModHostReads {
    return {
      actorsInChunk: (x, y, z) => {
        const rows: Array<Record<string, unknown>> = [];
        const world = this.session.world;
        const selfChunk = world.self.chunk;
        if (
          selfChunk &&
          BigInt(selfChunk.x) === x &&
          BigInt(selfChunk.y) === y &&
          BigInt(selfChunk.z) === z
        ) {
          const s = world.self.state;
          rows.push({
            uuid: world.self.uuid,
            self: true,
            name: s.name,
            x: s.x,
            y: s.y,
            z: s.z,
            program: s.program,
          });
        }
        for (const p of this.session.players()) {
          if (BigInt(p.chunk.x) === x && BigInt(p.chunk.y) === y && BigInt(p.chunk.z) === z) {
            rows.push({
              uuid: p.uuid,
              name: p.pose.name,
              x: p.pose.x,
              y: p.pose.y,
              z: p.pose.z,
              program: p.pose.program,
            });
          }
        }
        return rows;
      },
      chunkVoxels: (x, y, z) => {
        const cached = this.session.world.chunks.get({ x: Number(x), y: Number(y), z: Number(z) });
        if (!cached?.voxels) return { voxelsBase64: null };
        return { voxelsBase64: bytesToBase64(cached.voxels) };
      },
    };
  }

  private adoptGrid(grid: GridSnapshot | null, chunk: ChunkCoord): void {
    this.currentGrid = grid;
    this.lastGridChunkKey = chunkKey(chunk);
    this.lastGridReadAt = Date.now();
    if (this.lifecycle.enterGrid(grid?.gridId ?? null)) {
      this.declinedAuthors.clear();
      this.approvedAuthors.clear();
      this.lastModsReadAt = 0;
      this.gridEnteredAt = Date.now();
    }
    this.state = { ...this.state, grid };
    this.emit();
  }

  private setOpen(open: boolean): void {
    if (this.state.open === open) return;
    this.state = { ...this.state, open };
    this.session.studioOpen = open;
    this.emit();
  }

  private readRightInset(): number {
    const raw = document.body.style.getPropertyValue('--ck-game-right-inset');
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) ? px : 0;
  }

  /** Periodic: which grid are we on, and are there mods to run for us? */
  private async poll(): Promise<void> {
    if (!this.session.joined || !this.session.network.hasGame) return;
    const selfChunk = this.session.world.self.chunk;
    if (!selfChunk) return;
    const chunk = { x: Number(selfChunk.x), y: Number(selfChunk.y), z: Number(selfChunk.z) };
    const key = chunkKey(chunk);
    const now = Date.now();
    if (key !== this.lastGridChunkKey || now - this.lastGridReadAt > GRID_REFRESH_MS) {
      try {
        const grid = await this.grids.lookup(chunk);
        this.adoptGrid(grid, chunk);
      } catch (error) {
        this.session.network.log(`grid lookup failed: ${messageOf(error)}`);
      }
    }
    if (
      this.state.clientModsAvailable &&
      this.currentGrid &&
      !this.currentGrid.owned &&
      now - this.gridEnteredAt >= GRID_SETTLE_MS
    ) {
      await this.syncGridClientMods(this.currentGrid);
    }
  }

  /**
   * Visitor path: fetch the grid's attached CLIENT mods, ask once per author
   * whether to trust them, and run the trusted/consented ones. Re-run on a
   * cadence so a hash change stops the old worker.
   */
  private async syncGridClientMods(grid: GridSnapshot): Promise<void> {
    const now = Date.now();
    if (this.modsInFlight || now - this.lastModsReadAt < MODS_REFRESH_MS) return;
    const scope = this.lifecycle.scope(grid.gridId);
    if (!scope) return;
    this.lastModsReadAt = now;
    this.modsInFlight = true;
    try {
      const client = this.session.network.game;
      const appId = this.session.appId;
      let mods = await client.marketplace.gridClientMods({ appId, gridId: grid.gridId });
      if (!this.lifecycle.reconcile(scope, mods.map(descriptorOf))) return;

      let trustedAny = false;
      for (const mod of mods) {
        if (mod.callerTrustsAuthor) continue;
        const authorKey = `${mod.authorKind}:${mod.authorRef}:${mod.authorCapabilityHash}`;
        if (this.declinedAuthors.has(authorKey)) continue;
        if (!this.approvedAuthors.has(authorKey)) {
          const approved = await this.confirmTrust(
            `Trust ${String(mod.authorKind).toLowerCase()} ${mod.authorRef}'s mods on this grid?\n\n` +
              'Their client code will run in a sandbox while you are here.\n\n' +
              prettyCapabilities(mod.authorCapabilitySummaryJson),
          );
          if (!approved) {
            this.declinedAuthors.add(authorKey);
            continue;
          }
          // Remembered so a transient refusal (presence not registered yet)
          // retries silently instead of asking the player again.
          this.approvedAuthors.add(authorKey);
        }
        await client.marketplace.trustGridAuthor({
          appId,
          gridId: grid.gridId,
          authorKind: mod.authorKind,
          authorRef: mod.authorRef,
          consentCapabilityHash: mod.authorCapabilityHash,
        });
        if (!this.lifecycle.isCurrent(scope)) return;
        trustedAny = true;
      }
      if (trustedAny) {
        mods = await client.marketplace.gridClientMods({ appId, gridId: grid.gridId });
        if (!this.lifecycle.isCurrent(scope)) return;
      }
      for (const mod of mods) {
        if (!this.lifecycle.isCurrent(scope)) return;
        if (
          (mod.callerTrustsAuthor || mod.callerConsented) &&
          !this.lifecycle.has(mod.attachmentId)
        ) {
          await this.runGridMod(mod, grid, scope);
        }
      }
    } catch (error) {
      this.session.network.log(`grid client-mod refresh failed: ${messageOf(error)}`);
    } finally {
      this.modsInFlight = false;
      this.state = { ...this.state, clientModsRunning: this.lifecycle.runningCount };
      this.emit();
    }
  }

  private async runGridMod(
    mod: {
      attachmentId: string;
      clientArtifactHash: string;
      capabilityHash: string;
      listingName?: string | null;
    },
    grid: GridSnapshot,
    scope: ClientModScope,
  ): Promise<void> {
    const handle = await runConsentedGridMod({
      client: this.session.network.game,
      appId: this.session.appId,
      attachmentId: mod.attachmentId,
      artifactCacheKey: mod.clientArtifactHash,
      hudSource: `grid:${mod.attachmentId}`,
      hudLabel: mod.listingName || 'Grid mod',
      grid: toBrokerBounds(grid.bounds),
      workerUrl: glueWorkerAssetUrl,
      reads: this.reads(),
      hud: this.hud,
    });
    if (handle) {
      this.lifecycle.track(scope, descriptorOf(mod), handle);
    }
  }

  private async confirmTrust(summary: string): Promise<boolean> {
    if (this.hooks?.confirmTrust) return this.hooks.confirmTrust(summary);
    return window.confirm(summary);
  }

  private emit(): void {
    this.events.emit('state', this.state);
  }
}

function descriptorOf(mod: {
  attachmentId: string;
  clientArtifactHash: string;
  capabilityHash: string;
}) {
  return {
    attachmentId: mod.attachmentId,
    artifactHash: mod.clientArtifactHash,
    capabilityHash: mod.capabilityHash,
  };
}

function prettyCapabilities(json: string | null | undefined): string {
  if (!json) return '(no capability summary)';
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([k, v]) => `• ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
        .join('\n');
    }
    return String(parsed);
  } catch {
    return json;
  }
}
