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
 *  - input suppression and layout hooks,
 *  - the visitor lifecycle: when you stand on someone else's grid, their
 *    trusted CLIENT mods run for you after you approve them, and
 *  - the Agentic Crowdy Studio host (Ask / Build / Play) when the platform
 *    policy and `use_studio_agent` are armed.
 *
 * CLIENT mods need `crossOriginIsolated` (COOP + COEP headers on the host). The
 * service checks that at construction and hides the CLIENT half when it is
 * missing, saying so in the HUD, rather than letting a worker fail silently.
 */
import { createGridHostCalls, type PlayerCodeHostCall } from '@crowdedkingdoms/crowdyjs';
import {
  CrowdyStudioEmbed,
  CrowdyStudioTextHud,
  type CrowdyStudioEmbedContext,
} from '@crowdedkingdoms/crowdyjs/crowdy-studio';
import glueWorkerAssetUrl from '@crowdedkingdoms/crowdyjs/player-glue-worker?worker&url';

import { API_HTTP_URL, API_WS_URL, CLIENT_MODS_ENABLED, GAME_NAME, STUDIO_ORIGIN } from '../config';
import { GridProgramRunner } from '../../grid/GridProgramRunner';
import type { GameSession } from '../GameSession';
import { messageOf } from '../network/NetworkManager';
import { isTextEntry } from '../../engine/Input';
import { chunkKey, worldToChunk, type ChunkCoord, type Vec3 } from '../realtime/space';
import { AgentLocomotion } from './agentLocomotion';
import { ClientModLifecycle, type ClientModScope } from './ClientModLifecycle';
import { ConstructPlayerHostAdapter } from './ConstructPlayerHostAdapter';
import { HumanInputMonitor } from './HumanInputMonitor';
import {
  bytesToBase64,
  DEFAULT_VOXEL_STATE,
  routeClientHostCall,
  routeWithFallback,
  runConsentedGridMod,
  type ClientModHostReads,
  type ClientModHostWrites,
} from './clientModHost';
import { PointerClickBuffer } from './pointerClicks';
import { ModOverlayStore } from './modOverlay';
import { bindModGrid, bindModSession, releaseModChunk } from './modChunkRuntime';
import { GridService, type GridSnapshot } from './GridService';
import { hasAnyStudioPermission, toBrokerBounds } from './permissions';
import { Emitter } from '../util/Emitter';

export interface StudioState {
  open: boolean;
  grid: GridSnapshot | null;
  /** COOP/COEP present and the build flag on. */
  clientModsAvailable: boolean;
  clientModsRunning: number;
  /** Why CLIENT mods are unavailable, when they are. */
  clientModsReason: string | null;
  /** Agent dock mounted (policy + permission + host). */
  agentReady: boolean;
  /** Why the agent dock is hidden or dead, when it is. */
  agentReason: string | null;
}

export interface StudioHooks {
  suppressGameplayInput(): () => void;
  onLayoutChange(rightInsetPx: number): void;
  notify(text: string, tone?: 'info' | 'warn' | 'error'): void;
  /** Ask the player whether to trust an author's mods; defaults to `confirm`. */
  confirmTrust?(summary: string): Promise<boolean>;
  /** Screenshot hook for the agent pane. */
  captureFrame?(): Promise<HTMLCanvasElement | ImageBitmap | Blob | null>;
  describeView?(): string | undefined;
}

/**
 * CrowdyJS TextHud JSON.stringifies payloads and clips them at 200 characters,
 * which turns an ASCII table into a one-line `{greeting:"BILL…`. Prefer a
 * `greeting` string (still textContent, never HTML) and do not clip it.
 */
function createConstructTextHud(): CrowdyStudioTextHud {
  const hud = new CrowdyStudioTextHud();
  Object.assign(hud, {
    describe(payload: unknown) {
      if (typeof payload === 'string') return payload;
      if (payload && typeof payload === 'object') {
        const greeting = (payload as { greeting?: unknown }).greeting;
        if (typeof greeting === 'string' && greeting.length > 0) return greeting;
      }
      try {
        return JSON.stringify(payload);
      } catch {
        return '(unrenderable payload)';
      }
    },
  });
  return hud;
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
  /** Play locomotion wishes; HolodeckScene samples these each frame. */
  readonly locomotion = new AgentLocomotion();
  /** CLIENT overlay_draw gizmos; the holodeck merges these onto instances. */
  readonly overlay = new ModOverlayStore();
  private readonly hud = createConstructTextHud();
  private readonly lifecycle = new ClientModLifecycle();
  private readonly declinedAuthors = new Set<string>();
  private readonly approvedAuthors = new Set<string>();
  private readonly agentHost: ConstructPlayerHostAdapter;
  private readonly humanInput = new HumanInputMonitor();
  private readonly pointerClicks = new PointerClickBuffer();
  /** JS grid programs the agent (or the player) runs on the current grid. */
  readonly programs: GridProgramRunner;
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
    this.programs = new GridProgramRunner({
      client: () => this.session.network.game,
      appId: () => this.session.appId,
      graphqlUrl: `${API_HTTP_URL}/graphql`,
      graphqlWsUrl: `${API_WS_URL}/graphql`,
      sandboxUrl: `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}grid-program.html`,
      owns: (gridId) => this.currentGrid?.gridId === gridId && this.currentGrid.owned,
    });
    this.agentHost = new ConstructPlayerHostAdapter({
      frame: () => this.observationFrame(),
      locomotion: this.locomotion,
      sendChat: (text) => this.session.chat.send(text),
    });
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
      agentReady: false,
      agentReason: null,
    };
  }

  /** Grid the local player is standing on, if known. */
  get grid(): GridSnapshot | null {
    return this.currentGrid;
  }

  /** Wire the engine-side hooks; call once after the loop exists. */
  attach(hooks: StudioHooks): void {
    this.hooks = hooks;
    const network = () => this.session.network;
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
        // The GitHub card rides the game's app token on purpose: the API
        // scopes every crowdyStudioGitHub* working-tree field to projects
        // this token's user owns, so no identity session is needed here
        // (and this page never holds one — it signs in through hosted
        // /authorize). Connect / Bind / Unbind are identity-only and happen
        // in hosted Studio. GitHub is optional; a project saves in Studio
        // either way.
        get crowdyStudioGitHub() {
          return network().game.crowdyStudioGitHub;
        },
      },
      appId: () => this.session.appId,
      gameName: GAME_NAME,
      closeKeyCode: 'KeyM',
      dsh: {
        graphql: network().game.graphql,
        // Under Vite's base, so a build served from a sub-path (`vite build
        // --base /the-construct/`) finds its own harness instead of the
        // origin's root. The default base is '/', which keeps '/dsh/'.
        webBase: `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}dsh/`,
        graphqlUrl: `${API_HTTP_URL}/graphql`,
        apiOrigin: API_HTTP_URL,
        getToken: () => network().game.getToken(),
        persistScope: `${this.session.appId}/${this.session.selfUuid}`,
        studioOrigin: STUDIO_ORIGIN ?? undefined,
        openOnMount: true,
      },
      onAgentMounted: (_handle) => {
        this.state = { ...this.state, agentReady: true, agentReason: null };
        this.emit();
      },
      onAgentUnavailable: (message) => {
        this.state = { ...this.state, agentReady: false, agentReason: message };
        this.emit();
      },
      onAgentUnmounted: () => {
        this.state = { ...this.state, agentReady: false, agentReason: null };
        this.emit();
      },
      suppressGameplayInput: () => hooks.suppressGameplayInput(),
      onLayoutChange: () => hooks.onLayoutChange(this.readRightInset()),
      onClosed: () => {
        if (this.currentGrid) {
          const source = `studio:${this.currentGrid.gridId}`;
          this.overlay.remove(source);
          this.hud.remove(source);
        }
        this.setOpen(false);
      },
    });
    if (!this.timer) this.timer = setInterval(() => void this.poll(), 2000);
    this.pointerClicks.attach();
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
    if (this.currentGrid) {
      const source = `studio:${this.currentGrid.gridId}`;
      this.overlay.remove(source);
      this.hud.remove(source);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lifecycle.shutdown();
    this.programs.stopAll();
    this.embed?.destroy();
    this.embed = null;
    this.locomotion.clear();
    this.humanInput.dispose();
    this.pointerClicks.dispose();
    this.hud.destroy();
    this.overlay.clear();
    releaseModChunk();
  }

  // ---------------------------------------------------------------------------

  private openOn(grid: GridSnapshot): void {
    if (!this.embed) throw new Error('Studio not attached');
    this.embed.toggle(this.contextFor(grid));
    this.setOpen(true);
  }

  private contextFor(grid: GridSnapshot): CrowdyStudioEmbedContext {
    const bounds = toBrokerBounds(grid.bounds, grid.gridId);
    const clientOk = this.state.clientModsAvailable;
    const reads = this.reads();
    const writes = this.writes();
    const serverCalls = this.serverCallsFor(grid);
    const overlaySource = `studio:${grid.gridId}`;
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
            onHostCall: (call: PlayerCodeHostCall) =>
              routeWithFallback(
                call,
                () => routeClientHostCall(call, reads, bounds, writes, this.pointerClicks),
                serverCalls,
              ),
            onPresentation: (presentation) => {
              if (presentation.channel === 'hud') {
                this.hud.set({
                  source: overlaySource,
                  label: 'Crowdy Studio preview',
                  payload: presentation.payload,
                });
              }
              if (presentation.channel === 'overlay') {
                this.overlay.apply(overlaySource, presentation.payload, bounds);
              }
            },
            hud: this.hud,
          }
        : {}),
      playerHost: this.agentHost,
      dshHost: {
        captureFrame: async () => (await this.hooks?.captureFrame?.()) ?? null,
        describeView: () => this.hooks?.describeView?.(),
        grid: this.programs,
      },
    };
  }

  /**
   * The rest of the CLIENT host catalog for a mod on `grid` (DN-10): channels,
   * the player-tier model, sessions and user state through CrowdyJS, confined
   * to the grid. The local router still answers world reads and voxel writes.
   */
  private serverCallsFor(grid: GridSnapshot): (call: PlayerCodeHostCall) => Promise<unknown> {
    const game = this.session.network.game;
    const scope = game.grid(this.session.appId, grid.gridId, toBrokerBounds(grid.bounds));
    return createGridHostCalls({ scope, client: game });
  }

  private observationFrame() {
    const pose = this.session.joined ? this.session.world.self.state : null;
    const nearby = this.session.players().map((player) => ({
      actorId: player.uuid,
      position: { x: player.pose.x, y: player.pose.y, z: player.pose.z },
      label: player.pose.name || undefined,
    }));
    return {
      playerId: this.session.joined ? this.session.selfUuid : 'local',
      position: pose ? { x: pose.x, y: pose.y, z: pose.z } : { x: 0, y: 0, z: 0 },
      velocity: pose ? { x: pose.vx, y: pose.vy, z: pose.vz } : { x: 0, y: 0, z: 0 },
      yaw: pose?.yaw ?? 0,
      pitch: pose?.pitch ?? 0,
      grid: this.currentGrid,
      nearbyActors: nearby,
      humanInputActive: this.humanInput.active(),
      textInputFocused: isTextEntry(
        typeof document === 'undefined' ? null : document.activeElement,
      ),
      modalOpen: this.embed?.modal ?? false,
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

  private writes(): ClientModHostWrites {
    return {
      setVoxel: async (input) => {
        const chunks = this.session.world.chunks;
        const ok = await chunks.setVoxel({
          chunk: input.chunk,
          x: input.x,
          y: input.y,
          z: input.z,
          voxelType: input.voxelType,
          state: input.state ?? DEFAULT_VOXEL_STATE,
        });
        if (ok) chunks.markDirty(input.chunk);
        return ok;
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
      this.overlay.clear();
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
      if (this.lifecycle.runningCount === 0) releaseModChunk();
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
    const bounds = toBrokerBounds(grid.bounds, grid.gridId);
    bindModGrid(bounds);
    bindModSession({
      client: this.session.network.game,
      appId: this.session.appId,
      gridId: grid.gridId,
      selfUuid: this.session.selfUuid,
      userId: this.session.userId,
      moveTo: (chunk) => this.session.moveTo(chunk),
      players: () =>
        this.session.players().map((player) => ({
          uuid: player.uuid,
          pose: { x: player.pose.x, y: player.pose.y, z: player.pose.z },
        })),
      voiceStart: () => this.session.voice.start(),
      voiceStop: () => this.session.voice.stop(),
      videoStart: () => this.session.webcam.start(),
      videoStop: () => this.session.webcam.stop(),
    });
    const tick = (mod as { clientTickIntervalMs?: number }).clientTickIntervalMs;
    const handle = await runConsentedGridMod({
      client: this.session.network.game,
      appId: this.session.appId,
      attachmentId: mod.attachmentId,
      artifactCacheKey: mod.clientArtifactHash,
      hudSource: `grid:${mod.attachmentId}`,
      hudLabel: mod.listingName || 'Grid mod',
      grid: bounds,
      workerUrl: glueWorkerAssetUrl,
      serverCalls: this.serverCallsFor(grid),
      reads: this.reads(),
      writes: this.writes(),
      hud: this.hud,
      overlay: this.overlay,
      input: this.pointerClicks,
      tickIntervalMs: typeof tick === 'number' && tick > 0 ? tick : 1000,
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
