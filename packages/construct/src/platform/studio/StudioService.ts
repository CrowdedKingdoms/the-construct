/**
 * Crowdy Studio, embedded — the in-game IDE where players write SERVER and
 * CLIENT Rust mods for the grid they stand on. A project runs as a ck-exec mod
 * (`serverEngine: 'ck-exec'`): its SERVER target is a `ckx-sdk` crate the
 * platform builds, deploys to the grid and switches on, which players in the
 * grid call as `mod:<name>`; its CLIENT target is a `crowdy-client-sdk` crate
 * the platform builds as that mod's CLIENT half, which the grid serves to the
 * players who stand in it.
 *
 * The SDK's embed kit owns the chrome (dock, fullscreen fallback, Context
 * drawer, focus trap, HUD sink). This service supplies what only the game
 * knows:
 *  - the grid the player is on and their effective permissions on it,
 *  - the same-origin glue worker that runs CLIENT halves,
 *  - the allowlisted host-call router (what a CLIENT half may read),
 *  - input suppression and layout hooks,
 *  - the grid's CLIENT halves wherever you stand (`GridClientHalves`): the
 *    ones you consented to, or whose author you trust, run for you, you are
 *    asked about the rest, and they stop when you leave the grid, and
 *  - the Agentic Crowdy Studio host (Ask / Build / Play) when the platform
 *    policy and `use_studio_agent` are armed.
 *
 * CLIENT halves need `crossOriginIsolated` (COOP + COEP headers on the host).
 * The service checks that at construction and hides the CLIENT target when it
 * is missing, saying so in the HUD, rather than letting a worker fail silently.
 */
import {
  createGridHostCalls,
  type ExecClientHalfPrompt,
  type ExecGridClientMod,
  type PlayerCodeHostCall,
} from '@crowdedkingdoms/crowdyjs';
import {
  CrowdyStudioEmbed,
  CrowdyStudioTextHud,
  type CrowdyStudioController,
  type CrowdyStudioEmbedContext,
  type CrowdyStudioPlayerCompute,
} from '@crowdedkingdoms/crowdyjs/crowdy-studio';
import glueWorkerAssetUrl from '@crowdedkingdoms/crowdyjs/player-glue-worker?worker&url';

import { API_HTTP_URL, API_WS_URL, CLIENT_MODS_ENABLED, GAME_NAME, STUDIO_ORIGIN } from '../config';
import { GridProgramRunner } from '../../grid/GridProgramRunner';
import type { GameSession } from '../GameSession';
import { messageOf } from '../network/NetworkManager';
import { isTextEntry } from '../../engine/Input';
import { chunkKey, worldToChunk, type ChunkCoord, type Vec3 } from '../realtime/space';
import { AgentLocomotion } from './agentLocomotion';
import { describeClientHalfPrompt, GridClientHalves, studioPreviewModName } from './clientHalves';
import { ConstructPlayerHostAdapter } from './ConstructPlayerHostAdapter';
import { HumanInputMonitor } from './HumanInputMonitor';
import {
  bytesToBase64,
  DEFAULT_VOXEL_STATE,
  routeClientHostCall,
  routeWithFallback,
  voxelStateToWire,
  type ClientModHostReads,
  type ClientModHostWrites,
} from './clientModHost';
import { PointerClickBuffer } from './pointerClicks';
import { clearModPose, setModPoseGrid } from './modPose';
import type { Input } from '../../engine/Input';
import { ModOverlayStore } from './modOverlay';
import { bindModGrid, bindModSession, releaseModChunk } from './modChunkRuntime';
import { ModSceneStore } from './modScene';
import { GridService, type GridSnapshot } from './GridService';
import { hasAnyStudioPermission, toBrokerBounds, type GridBounds } from './permissions';
import { Emitter } from '../util/Emitter';

export interface StudioState {
  open: boolean;
  grid: GridSnapshot | null;
  /** COOP/COEP present and the build flag on. */
  clientModsAvailable: boolean;
  /** The grid's CLIENT halves running for this player. */
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
  /**
   * Ask the player whether to run a grid's CLIENT halves; `summary` is the
   * question as plain text. `signal` aborts when they leave the grid. Defaults
   * to `confirm`.
   */
  confirmTrust?(
    summary: string,
    context: { prompt: ExecClientHalfPrompt; signal: AbortSignal },
  ): Promise<boolean>;
  /** Ask once per author (the default) or once per CLIENT half. */
  clientHalfConsent?: 'author' | 'mod';
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
        const rec = payload as {
          greeting?: unknown;
          turn?: unknown;
          scores?: unknown;
          state?: unknown;
          who?: unknown;
        };
        const lines: string[] = [];
        for (const key of ['greeting', 'turn', 'scores', 'state', 'who'] as const) {
          const value = rec[key];
          if (typeof value === 'string' && value.length > 0) lines.push(value);
        }
        if (lines.length > 0) return lines.join('\n');
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

/**
 * CrowdyJS 17's embed types a legacy player compute service, which it never
 * calls while both targets run on ck-exec; this one refuses, so nothing can
 * reach the switched-off engine.
 */
const NO_PLAYER_COMPUTE: CrowdyStudioPlayerCompute = {
  deploy: refuseLegacyEngine,
  versions: refuseLegacyEngine,
  setEnabled: refuseLegacyEngine,
  setRequires: refuseLegacyEngine,
  artifactBytes: refuseLegacyEngine,
  usage: refuseLegacyEngine,
  runs: refuseLegacyEngine,
  logs: refuseLegacyEngine,
  invoke: refuseLegacyEngine,
};

function refuseLegacyEngine(): Promise<never> {
  return Promise.reject(
    new Error('Crowdy Studio runs mods on ck-exec here; legacy player compute is not used'),
  );
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
  /** CLIENT scene_catalog / scene_instances. Templates are cloned in the page. */
  readonly scene = new ModSceneStore();
  private readonly hud = createConstructTextHud();
  private readonly agentHost: ConstructPlayerHostAdapter;
  private readonly humanInput = new HumanInputMonitor();
  private readonly pointerClicks = new PointerClickBuffer();
  /** JS grid programs the agent (or the player) runs on the current grid. */
  readonly programs: GridProgramRunner;
  private gameplay: Input | null = null;
  private halves: GridClientHalves | null = null;
  private gridEnteredAt = 0;
  private embed: CrowdyStudioEmbed | null = null;
  private hooks: StudioHooks | null = null;
  private state: StudioState;
  private currentGrid: GridSnapshot | null = null;
  private lastGridChunkKey: string | null = null;
  private lastGridReadAt = 0;
  private lastModsReadAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last GraphQL-persisted mailbox payload per cell, so roster ticks do not hammer updateVoxel. */
  private lastDurableVoxel = new Map<string, string>();
  private voxelUpdateCache = new Map<
    string,
    { at: number; states: Array<{ x: number; y: number; z: number; state: string }> }
  >();
  /** The grid the open Studio edits, and the mod its project runs as. */
  private studioGridId: string | null = null;
  private studioMod: string | null = null;
  private unwatchStudio: (() => void) | null = null;

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

  /** Gameplay keys and stick for generic client-mod input calls. */
  bindGameplayInput(input: Input): void {
    this.gameplay = input;
  }

  private hostInput() {
    return {
      drainPointerClicks: () => this.pointerClicks.drainPointerClicks(),
      axes: () =>
        this.gameplay && !this.gameplay.suppressed ? this.gameplay.axes() : { x: 0, y: 0 },
      look: () => this.gameplay?.takePointerDelta() ?? { dx: 0, dy: 0 },
      keyDown: (code: string) => this.gameplay?.isDown(code) ?? false,
    };
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
        playerCompute: NO_PLAYER_COMPUTE,
        // Both targets' builds, deploys, switch and preview (`serverEngine` below).
        get exec() {
          return network().game.exec;
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
      // The SERVER target runs as the grid's mod and the CLIENT target as that mod's CLIENT
      // half, which the grid serves to the players standing in it (GridClientHalves).
      serverEngine: 'ck-exec',
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
      onAgentMounted: (handle) => {
        this.watchStudio(handle.controller);
        this.state = { ...this.state, agentReady: true, agentReason: null };
        this.emit();
      },
      onAgentUnavailable: (message) => {
        this.state = { ...this.state, agentReady: false, agentReason: message };
        this.emit();
      },
      onAgentUnmounted: () => {
        this.watchStudio(null);
        this.state = { ...this.state, agentReady: false, agentReason: null };
        this.emit();
      },
      suppressGameplayInput: () => hooks.suppressGameplayInput(),
      onLayoutChange: () => hooks.onLayoutChange(this.readRightInset()),
      onClosed: () => {
        if (this.currentGrid) {
          const source = `studio:${this.currentGrid.gridId}`;
          this.overlay.remove(source);
          this.scene.remove(source);
          this.hud.remove(source);
        }
        this.studioGridId = null;
        this.setOpen(false);
        void this.refreshClientHalves();
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
      this.scene.remove(source);
      this.hud.remove(source);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.halves?.stop();
    this.halves = null;
    this.watchStudio(null);
    this.programs.stopAll();
    this.embed?.destroy();
    this.embed = null;
    this.locomotion.clear();
    this.humanInput.dispose();
    this.pointerClicks.dispose();
    this.hud.destroy();
    this.overlay.clear();
    releaseModChunk();
    this.scene.clear();
  }

  // ---------------------------------------------------------------------------

  private openOn(grid: GridSnapshot): void {
    if (!this.embed) throw new Error('Studio not attached');
    this.embed.toggle(this.contextFor(grid));
    this.studioGridId = this.embed.open ? grid.gridId : null;
    this.setOpen(true);
  }

  private contextFor(grid: GridSnapshot): CrowdyStudioEmbedContext {
    const bounds = toBrokerBounds(grid.bounds, grid.gridId);
    const clientOk = this.state.clientModsAvailable;
    const reads = this.reads();
    const writes = this.writes();
    const serverCalls = this.serverCallsFor(grid.gridId, grid.bounds);
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
            onHostCall: (call: PlayerCodeHostCall) => {
              setModPoseGrid(bounds);
              return routeWithFallback(
                call,
                () =>
                  routeClientHostCall(call, reads, bounds, writes, this.hostInput(), {
                    source: overlaySource,
                    store: this.scene,
                  }),
                serverCalls,
              );
            },
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
   * The rest of the CLIENT host catalog for a mod on a grid (DN-10): channels,
   * sessions and user state through CrowdyJS, confined to the grid. The local
   * router still answers world reads and voxel writes.
   */
  private serverCallsFor(
    gridId: string,
    bounds: GridBounds,
  ): (call: PlayerCodeHostCall) => Promise<unknown> {
    const game = this.session.network.game;
    const scope = game.grid(this.session.appId, gridId, toBrokerBounds(bounds));
    return createGridHostCalls({ scope, client: game });
  }

  /**
   * The grid's CLIENT halves, made on first use: the app is entered by then,
   * and the whole service is rebuilt for another app.
   */
  private clientHalves(): GridClientHalves {
    this.halves ??= new GridClientHalves({
      exec: () => this.session.network.game.exec,
      appId: this.session.appId,
      workerUrl: glueWorkerAssetUrl,
      selfUserId: () => this.session.network.user?.userId ?? null,
      reads: this.reads(),
      writes: this.writes(),
      input: this.hostInput(),
      scene: this.scene,
      serverCalls: (grid) =>
        this.serverCallsFor(grid.gridId, {
          low: stringCorner(grid.bounds.low),
          high: stringCorner(grid.bounds.high),
        }),
      hud: this.hud,
      overlay: this.overlay,
      ask: this.hooks?.clientHalfConsent ?? 'author',
      confirm: (prompt, signal) =>
        this.confirmTrust(describeClientHalfPrompt(prompt, this.authorName(prompt)), {
          prompt,
          signal,
        }),
      filter: (mod) => !this.previewedByStudio(mod),
      onChange: (running) => {
        this.state = { ...this.state, clientModsRunning: running.length };
        this.emit();
      },
      log: (line) => this.session.network.log(line),
    });
    return this.halves;
  }

  /** The open Studio previews its project's CLIENT half itself; the grid's copy waits. */
  private previewedByStudio(mod: ExecGridClientMod): boolean {
    return (
      this.isOpen &&
      this.studioMod !== null &&
      String(mod.gridId) === this.studioGridId &&
      mod.name === this.studioMod
    );
  }

  private watchStudio(controller: CrowdyStudioController | null): void {
    this.unwatchStudio?.();
    this.unwatchStudio = null;
    const follow = (mod: string | null) => {
      if (mod === this.studioMod) return;
      this.studioMod = mod;
      void this.refreshClientHalves();
    };
    if (!controller) {
      follow(null);
      return;
    }
    this.unwatchStudio = controller.subscribe((state) =>
      follow(state.project ? studioPreviewModName(state.project) : null),
    );
  }

  private authorName(prompt: ExecClientHalfPrompt): string | null {
    const grid = this.currentGrid;
    return grid && grid.gridId === String(prompt.gridId) ? (grid.ownerName ?? null) : null;
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
            yaw: s.yaw,
            pitch: s.pitch,
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
              yaw: p.pose.yaw,
              pitch: p.pose.pitch,
              program: p.pose.program,
            });
          }
        }
        return rows;
      },
      chunkVoxels: async (x, y, z) => {
        const cached = this.session.world.chunks.get({ x: Number(x), y: Number(y), z: Number(z) });
        const states: Array<{ x: number; y: number; z: number; state: string }> = [];
        if (cached) {
          for (const [index, state] of cached.voxelStates) {
            if (typeof state !== 'string' || state.length === 0) continue;
            states.push({
              x: index & 15,
              y: (index >> 4) & 15,
              z: (index >> 8) & 15,
              state,
            });
          }
        }
        const durable = await this.listDurableVoxelStates(Number(x), Number(y), Number(z));
        for (const extra of durable) {
          const row = states.find((s) => s.x === extra.x && s.y === extra.y && s.z === extra.z);
          if (row) row.state = extra.state;
          else states.push(extra);
        }
        if (!cached?.voxels && states.length === 0) return { voxelsBase64: null };
        return {
          voxelsBase64: bytesToBase64(cached?.voxels ?? new Uint8Array(4096)),
          states,
        };
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
        if (ok) {
          chunks.markDirty(input.chunk);
          void this.persistVoxelUpdate(input);
        }
        return ok;
      },
    };
  }

  /**
   * Draft SERVER voxel_set writes Postgres but suppresses Buddy fan-out, so the
   * live chunk cache never sees BOARD/SHOT mailboxes. Pull those states from
   * listVoxels (cached ~250ms) so the author's CLIENT can read them.
   */
  private async listDurableVoxelStates(
    x: number,
    y: number,
    z: number,
  ): Promise<Array<{ x: number; y: number; z: number; state: string }>> {
    const game = this.session.network.game;
    if (!game?.voxels?.list) return [];
    const key = `${x},${y},${z}`;
    const hit = this.voxelUpdateCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < 250) return hit.states;
    try {
      const rows = await game.voxels.list({
        appId: this.session.appId,
        coordinates: { x: String(x), y: String(y), z: String(z) },
      });
      const states: Array<{ x: number; y: number; z: number; state: string }> = [];
      for (const row of rows ?? []) {
        const loc = row.location;
        if (!loc) continue;
        const raw = row.state;
        if (typeof raw !== 'string' || raw.length === 0) continue;
        let decoded = raw;
        try {
          decoded = new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)));
        } catch {
          decoded = raw;
        }
        states.push({ x: loc.x, y: loc.y, z: loc.z, state: decoded });
      }
      this.voxelUpdateCache.set(key, { at: now, states });
      return states;
    } catch (error) {
      this.session.network.log(`voxel list failed: ${messageOf(error)}`);
      return hit?.states ?? [];
    }
  }
  private async persistVoxelUpdate(input: {
    chunk: { x: number; y: number; z: number };
    x: number;
    y: number;
    z: number;
    voxelType: number;
    state?: string;
  }): Promise<void> {
    const game = this.session.network.game;
    if (!game?.voxels?.update) return;
    const wire = voxelStateToWire(input.state ?? DEFAULT_VOXEL_STATE);
    const cell = `${input.chunk.x},${input.chunk.y},${input.chunk.z}:${input.x},${input.y},${input.z}`;
    const payload = `${input.voxelType}:${wire}`;
    if (this.lastDurableVoxel.get(cell) === payload) return;
    this.lastDurableVoxel.set(cell, payload);
    try {
      await game.voxels.update({
        appId: this.session.appId,
        coordinates: {
          x: String(input.chunk.x),
          y: String(input.chunk.y),
          z: String(input.chunk.z),
        },
        location: { x: input.x, y: input.y, z: input.z },
        voxelType: input.voxelType,
        state: wire,
      });
    } catch (error) {
      this.lastDurableVoxel.delete(cell);
      this.session.network.log(`voxel persist failed: ${messageOf(error)}`);
    }
  }

  private adoptGrid(grid: GridSnapshot | null, chunk: ChunkCoord): void {
    const entered = (grid?.gridId ?? null) !== (this.currentGrid?.gridId ?? null);
    this.currentGrid = grid;
    this.lastGridChunkKey = chunkKey(chunk);
    this.lastGridReadAt = Date.now();
    if (entered) {
      this.lastModsReadAt = 0;
      this.gridEnteredAt = Date.now();
      this.overlay.clear();
      this.scene.clear();
      clearModPose();
      if (grid) this.bindLiveMod(grid);
      else releaseModChunk();
      if (this.state.clientModsAvailable) {
        this.clientHalves().enterGrid(
          grid ? { gridId: grid.gridId, bounds: toBrokerBounds(grid.bounds) } : null,
        );
      }
    }
    this.state = {
      ...this.state,
      grid,
    };
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

  /** Periodic: which grid are we on, and are there CLIENT halves to run for us? */
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
    if (now - this.lastModsReadAt >= MODS_REFRESH_MS) await this.refreshClientHalves();
  }

  /**
   * Reconcile the grid's CLIENT halves: start the consented ones, ask about
   * the rest, stop what changed or went. Waits out the presence race after
   * entering a grid.
   */
  /** The live session gameplay calls (pose, events, voice) read from. */
  private bindLiveMod(grid: GridSnapshot): void {
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
  }

  private async refreshClientHalves(): Promise<void> {
    const halves = this.halves;
    if (!halves || !this.currentGrid || !this.state.clientModsAvailable) return;
    if (Date.now() - this.gridEnteredAt < GRID_SETTLE_MS) return;
    this.lastModsReadAt = Date.now();
    try {
      await halves.refresh();
    } catch (error) {
      this.session.network.log(`grid CLIENT halves unavailable: ${messageOf(error)}`);
    }
  }

  private async confirmTrust(
    summary: string,
    context: { prompt: ExecClientHalfPrompt; signal: AbortSignal },
  ): Promise<boolean> {
    if (this.hooks?.confirmTrust) return this.hooks.confirmTrust(summary, context);
    return window.confirm(summary);
  }

  private emit(): void {
    this.events.emit('state', this.state);
  }
}

function stringCorner(corner: { x: bigint; y: bigint; z: bigint }) {
  return { x: corner.x.toString(), y: corner.y.toString(), z: corner.z.toString() };
}
