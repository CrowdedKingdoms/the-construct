/**
 * The CLIENT halves of ck-exec mods on the grid the player stands in, run the
 * way this framework runs player code: through the game's host-call router,
 * into the text HUD and the holodeck overlay. CrowdyJS's `ExecClientHalves`
 * lists what the grid serves, asks, fetches by digest and sandboxes each half
 * in a `PlayerCodeBroker` (`engine: 'ck-exec'`); this adds what only the game
 * knows.
 *
 * The player's own CLIENT halves run without a question (on your own grid
 * every half is yours), unless one was installed from a marketplace listing:
 * that code is someone else's, so the owner is asked about it like a visitor.
 */
import {
  ExecClientHalves,
  type ExecAPI,
  type ExecClientCapabilitySummary,
  type ExecClientHalfError,
  type ExecClientHalfPrompt,
  type ExecClientHalfStopReason,
  type ExecClientHalvesOptions,
  type ExecGridClientMod,
  type PlayerCodeGridBounds,
  type PlayerCodeHostCall,
  type PlayerCodeLogLine,
  type PlayerCodePresentation,
} from '@crowdedkingdoms/crowdyjs';
import {
  projectTargets,
  type CrowdyStudioProject,
  type CrowdyStudioTextHud,
} from '@crowdedkingdoms/crowdyjs/crowdy-studio';

import {
  routeClientHostCall,
  routeWithFallback,
  type ClientModHostInput,
  type ClientModHostReads,
  type ClientModHostWrites,
} from './clientModHost';
import type { ModOverlayStore } from './modOverlay';

export type ClientHalvesExec = Pick<
  ExecAPI,
  'gridClientMods' | 'consentClientMod' | 'trustAuthor' | 'modClientArtifactBytes'
>;

/** The grid the player stands in: its id and chunk box. */
export interface ClientHalvesGrid {
  gridId: string;
  bounds: PlayerCodeGridBounds;
}

export interface GridClientHalvesOptions {
  /** The game client's `exec`, read at each call. */
  exec: () => ClientHalvesExec;
  appId: string;
  /** The platform glue worker (`@crowdedkingdoms/crowdyjs/player-glue-worker`), same origin. */
  workerUrl: string;
  /** The signed-in player's user id. */
  selfUserId: () => string | null;
  reads: ClientModHostReads;
  writes?: ClientModHostWrites;
  input?: ClientModHostInput;
  /**
   * Answers the host calls the game's router does not (DN-10: `createGridHostCalls`
   * over the grid's scope); made once per grid.
   */
  serverCalls?: (grid: ClientHalvesGrid) => (call: PlayerCodeHostCall) => Promise<unknown>;
  hud: CrowdyStudioTextHud;
  overlay?: ModOverlayStore;
  /** One question per author (the default), or one per CLIENT half. */
  ask?: 'author' | 'mod';
  /**
   * Asks the player about CLIENT halves they neither consented to nor trust the author of.
   * `signal` aborts when they leave the grid. Without it only what the player already agreed
   * to runs.
   */
  confirm?: (prompt: ExecClientHalfPrompt, signal: AbortSignal) => Promise<boolean>;
  /** Leaves out the CLIENT halves it returns false for, e.g. the one Crowdy Studio previews. */
  filter?: (mod: ExecGridClientMod) => boolean;
  /** After a CLIENT half starts or stops. */
  onChange?: (running: readonly ExecGridClientMod[]) => void;
  /**
   * A CLIENT half's `crowdy::log` lines (rate- and length-capped by the broker). The text is
   * the mod author's: render it as text. Without it they go to `log`.
   */
  onLog?: (line: PlayerCodeLogLine, mod: ExecGridClientMod) => void;
  log?: (line: string) => void;
  brokerFactory?: ExecClientHalvesOptions['brokerFactory'];
  now?: () => number;
}

export class GridClientHalves {
  private readonly runner: ExecClientHalves;
  private grid: ClientHalvesGrid | null = null;
  private serverCalls: ((call: PlayerCodeHostCall) => Promise<unknown>) | null = null;
  private asking: AbortController | null = null;

  constructor(private readonly options: GridClientHalvesOptions) {
    const exec = options.exec;
    this.runner = new ExecClientHalves({
      exec: {
        gridClientMods: (appId, gridId) => exec().gridClientMods(appId, gridId),
        consentClientMod: (appId, modId, hash) => exec().consentClientMod(appId, modId, hash),
        trustAuthor: (appId, gridId, authorId, hash) =>
          exec().trustAuthor(appId, gridId, authorId, hash),
        modClientArtifactBytes: (appId, modId) => exec().modClientArtifactBytes(appId, modId),
      },
      appId: options.appId,
      workerUrl: options.workerUrl,
      ask: options.ask ?? 'author',
      confirm: (prompt) => this.confirm(prompt),
      filter: options.filter,
      onHostCall: (call, mod) => this.hostCall(call, mod),
      onPresentation: (presentation, mod) => this.present(presentation, mod),
      onStarted: (mod) => {
        this.options.log?.(`CLIENT half of mod ${mod.name} started (version ${mod.clientVersion})`);
        this.options.onChange?.(this.running);
      },
      onStopped: (mod, reason) => this.stopped(mod, reason),
      onError: (error) => this.options.log?.(this.describeError(error)),
      onLog: (line, mod) => {
        if (this.options.onLog) this.options.onLog(line, mod);
        else this.options.log?.(`CLIENT half of mod ${mod.name} ${line.level}: ${line.message}`);
      },
      ...(options.brokerFactory ? { brokerFactory: options.brokerFactory } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** The CLIENT halves running now. */
  get running(): readonly ExecGridClientMod[] {
    return this.runner.running;
  }

  /** The grid the player stands in, or null; a change stops every CLIENT half of the old one. */
  enterGrid(grid: ClientHalvesGrid | null): void {
    if (sameGrid(this.grid, grid)) return;
    this.asking?.abort();
    this.asking = null;
    this.grid = grid ? { gridId: grid.gridId, bounds: grid.bounds } : null;
    this.serverCalls = null;
    this.runner.enterGrid(
      grid ? { gridId: grid.gridId, low: grid.bounds.low, high: grid.bounds.high } : null,
    );
  }

  /** One reconcile of the grid's CLIENT halves; rejects when they cannot be listed. */
  refresh(): Promise<void> {
    return this.runner.refresh();
  }

  /**
   * Calls the `handle_invoke` export of the running CLIENT half of mod `modId`. The reply is
   * the mod author's bytes: treat them as untrusted input.
   */
  invoke(
    modId: string,
    payload: Uint8Array,
    options?: { timeoutMs?: number },
  ): Promise<Uint8Array> {
    return this.runner.invoke(modId, payload, options);
  }

  stop(): void {
    this.asking?.abort();
    this.asking = null;
    this.grid = null;
    this.serverCalls = null;
    this.runner.stop();
  }

  private async confirm(prompt: ExecClientHalfPrompt): Promise<boolean> {
    if (isOwnClientHalfPrompt(prompt, this.options.selfUserId())) return true;
    if (!this.options.confirm) return false;
    this.asking ??= new AbortController();
    return this.options.confirm(prompt, this.asking.signal);
  }

  private hostCall(call: PlayerCodeHostCall, mod: ExecGridClientMod): Promise<unknown> {
    const grid = this.grid;
    if (!grid || String(mod.gridId) !== grid.gridId) {
      return Promise.reject(new Error('the player is no longer in this CLIENT half’s grid'));
    }
    if (!this.serverCalls && this.options.serverCalls) {
      this.serverCalls = this.options.serverCalls(grid);
    }
    const { reads, writes, input } = this.options;
    return routeWithFallback(
      call,
      () => routeClientHostCall(call, reads, grid.bounds, writes, input),
      this.serverCalls ?? undefined,
    );
  }

  private present(presentation: PlayerCodePresentation, mod: ExecGridClientMod): void {
    const grid = this.grid;
    if (!grid || String(mod.gridId) !== grid.gridId) return;
    const source = clientHalfSource(mod);
    if (presentation.channel === 'hud') {
      this.options.hud.set({ source, label: mod.name, payload: presentation.payload });
    }
    if (presentation.channel === 'overlay') {
      this.options.overlay?.apply(source, presentation.payload, grid.bounds);
    }
  }

  private stopped(mod: ExecGridClientMod, reason: ExecClientHalfStopReason): void {
    const source = clientHalfSource(mod);
    this.options.hud.remove(source);
    this.options.overlay?.remove(source);
    this.options.log?.(`CLIENT half of mod ${mod.name} stopped (${reason})`);
    this.options.onChange?.(this.running);
  }

  private describeError(error: ExecClientHalfError): string {
    const now = (this.options.now ?? Date.now)();
    const again =
      error.retryAt !== undefined
        ? `; tried again in ${Math.max(0, Math.round((error.retryAt - now) / 1000))} s`
        : '';
    const detail = error.error instanceof Error ? error.error.message : String(error.error);
    return `CLIENT half of mod ${error.mod.name}: ${error.stage} ${error.reason} (${detail})${again}`;
  }
}

/** The HUD and overlay source a CLIENT half writes to. */
export function clientHalfSource(mod: Pick<ExecGridClientMod, 'modId'>): string {
  return `grid:${mod.modId}`;
}

/** The player's own CLIENT halves, none installed from a listing: they run without a question. */
export function isOwnClientHalfPrompt(
  prompt: ExecClientHalfPrompt,
  selfUserId: string | null,
): boolean {
  return (
    selfUserId !== null &&
    String(prompt.authorId) === String(selfUserId) &&
    prompt.mods.every((mod) => mod.listingId == null)
  );
}

/** The question a player is asked about a grid's CLIENT halves, as plain text. */
export function describeClientHalfPrompt(
  prompt: ExecClientHalfPrompt,
  authorName?: string | null,
): string {
  const who = authorName?.trim() || `player ${prompt.authorId}`;
  const names = prompt.mods.map((mod) => mod.name);
  const installed = prompt.mods.filter((mod) => mod.listingId != null).map((mod) => mod.name);
  const lines =
    prompt.kind === 'author'
      ? [
          `Run ${who}'s code on this grid?`,
          '',
          `${names.join(', ')} will run in a sandbox in your browser while you stand here. ` +
            `Trusting ${who} covers their CLIENT halves on this grid until they need more than this.`,
        ]
      : [
          `Run the CLIENT half of ${names[0] ?? 'this mod'} by ${who}?`,
          '',
          'It runs in a sandbox in your browser while you stand here.',
        ];
  if (installed.length > 0) {
    lines.push('', `Installed from the marketplace: ${installed.join(', ')}.`);
  }
  lines.push(
    '',
    'It may use:',
    describeClientCapabilities(prompt.capabilitySummary, prompt.capabilitySummaryJson),
  );
  return lines.join('\n');
}

export function describeClientCapabilities(
  summary: ExecClientCapabilitySummary | null,
  json: string,
): string {
  if (!summary) return json || '(no capability summary)';
  const rows = [
    `• host calls: ${summary.hostFunctions.length > 0 ? summary.hostFunctions.join(', ') : 'none'}`,
  ];
  if (summary.capabilityGroups.length > 0) {
    rows.push(`• groups: ${summary.capabilityGroups.join(', ')}`);
  }
  return rows.join('\n');
}

/**
 * The mod whose CLIENT half a Studio project previews on ck-exec: its SERVER module for a
 * full-stack project, the CLIENT module a CLIENT-only project rides, and none for a
 * SERVER-only project.
 */
export function studioPreviewModName(project: CrowdyStudioProject): string | null {
  const targets = projectTargets(project.kind);
  if (!targets.includes('CLIENT')) return null;
  const name = targets.includes('SERVER')
    ? project.metadata.serverModuleName
    : project.metadata.clientModuleName;
  return name?.trim() || null;
}

function sameGrid(a: ClientHalvesGrid | null, b: ClientHalvesGrid | null): boolean {
  if (!a || !b) return a === b;
  const corner = (c: { x: bigint; y: bigint; z: bigint }) => `${c.x},${c.y},${c.z}`;
  return (
    a.gridId === b.gridId &&
    corner(a.bounds.low) === corner(b.bounds.low) &&
    corner(a.bounds.high) === corner(b.bounds.high)
  );
}
