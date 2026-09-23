/**
 * Page side of JS grid programs (DN-10 §5): player-authored JavaScript that
 * uses the full CrowdyJS SDK inside one grid.
 *
 * Each program runs in its own hidden `sandbox="allow-scripts"` iframe (an
 * opaque origin with no network, see `buildGridProgramCsp`). Its CrowdyJS
 * talks over a MessagePort that `hostGridProgram` relays with a grid-scoped
 * token, so the server confines everything it does to the grid. The runner
 * also answers the Crowdy Studio agent's grid requests (crowdy-dsh bridge v4).
 */
import type { CrowdyClient } from '@crowdedkingdoms/crowdyjs';
import type {
  CrowdyStudioDshGridHost,
  DshGridContext,
  DshGridProgramStatus,
} from '@crowdedkingdoms/crowdyjs/crowdy-dsh';
import { hostGridProgram, type GridProgramHost } from '@crowdedkingdoms/crowdyjs/grid-program';

import { GRID_PROGRAM_SOURCE, type GridProgramSandboxMessage } from './sandboxProtocol';

export interface GridProgramRunnerOptions {
  /** The page's client (holds the player's app token); resolved per call. */
  client: () => CrowdyClient;
  appId: () => string;
  /** ck-api GraphQL endpoints the relay dials (a function follows endpoint changes). */
  graphqlUrl: string | (() => string);
  graphqlWsUrl: string | (() => string);
  /** URL of the sandbox page, usually `${import.meta.env.BASE_URL}grid-program.html`. */
  sandboxUrl: string;
  /** Where the hidden iframes are attached (default document.body). */
  container?: () => HTMLElement;
  /** Whether the signed-in player owns a grid (for `grid.context`). */
  owns?: (gridId: string) => boolean;
  /** Called when a program's state changes (for a HUD line). */
  onChange?: (status: DshGridProgramStatus) => void;
}

interface RunningProgram {
  key: string;
  gridId: string;
  status: DshGridProgramStatus;
  iframe: HTMLIFrameElement;
  host: GridProgramHost | null;
  listener: (event: MessageEvent) => void;
}

const LOG_LINES = 200;
const READY_TIMEOUT_MS = 15_000;

export class GridProgramRunner implements CrowdyStudioDshGridHost {
  private readonly running = new Map<string, RunningProgram>();

  constructor(private readonly options: GridProgramRunnerOptions) {}

  async context(gridId: string): Promise<DshGridContext | null> {
    const scope = this.options.client().grid(this.options.appId(), gridId);
    const token = await scope.mintToken(60).catch(() => null);
    if (!token) return null;
    const [channels, sessions] = await Promise.all([
      scope.channels.list().catch(() => []),
      scope.sessions.list({ status: 'active' }).catch(() => []),
    ]);
    return {
      appId: this.options.appId(),
      gridId,
      low: token.lowChunk,
      high: token.highChunk,
      owned: this.options.owns?.(gridId) ?? false,
      channels: channels.map((c) => ({ groupId: String(c.groupId), name: c.name })),
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        name: s.name ?? null,
        status: s.status,
      })),
    };
  }

  async runProgram(input: {
    gridId: string;
    path: string;
    source: string;
    stop?: boolean;
  }): Promise<DshGridProgramStatus> {
    const key = `${input.gridId}:${input.path}`;
    this.stop(key);
    if (input.stop) return { path: input.path, running: false, log: [] };
    return this.start(key, input.gridId, input.path, input.source);
  }

  programs(): DshGridProgramStatus[] {
    return [...this.running.values()].map((p) => ({ ...p.status, log: [...p.status.log] }));
  }

  /** Stop every program (leaving a grid, signing out). */
  stopAll(gridId?: string): void {
    for (const program of [...this.running.values()]) {
      if (gridId === undefined || program.gridId === gridId) this.stop(program.key);
    }
  }

  private stop(key: string): void {
    const program = this.running.get(key);
    if (!program) return;
    program.host?.stop();
    window.removeEventListener('message', program.listener);
    program.iframe.remove();
    program.status = { ...program.status, running: false };
    this.running.delete(key);
    this.options.onChange?.(program.status);
  }

  private async start(
    key: string,
    gridId: string,
    path: string,
    source: string,
  ): Promise<DshGridProgramStatus> {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.title = `grid program ${path}`;
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    iframe.src = this.options.sandboxUrl;
    const status: DshGridProgramStatus = {
      path,
      running: false,
      startedAt: new Date().toISOString(),
      log: [],
    };
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const program: RunningProgram = {
      key,
      gridId,
      status,
      iframe,
      host: null,
      listener: (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;
        const data = event.data as ({ source?: string } & GridProgramSandboxMessage) | null;
        if (!data || data.source !== GRID_PROGRAM_SOURCE) return;
        switch (data.type) {
          case 'ready':
            resolveReady();
            return;
          case 'started':
            program.status = { ...program.status, running: true };
            break;
          case 'log':
            program.status = {
              ...program.status,
              log: [...program.status.log, `[${data.level}] ${data.line}`].slice(-LOG_LINES),
            };
            break;
          case 'error':
            program.status = {
              ...program.status,
              lastError: data.message,
              log: [...program.status.log, `[error] ${data.message}`].slice(-LOG_LINES),
            };
            break;
        }
        this.options.onChange?.(program.status);
      },
    };
    this.running.set(key, program);
    window.addEventListener('message', program.listener);
    (this.options.container?.() ?? document.body).appendChild(iframe);

    const timedOut = await Promise.race([
      ready.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), READY_TIMEOUT_MS)),
    ]);
    if (timedOut) {
      program.status = { ...program.status, lastError: 'the sandbox page did not load' };
      this.stop(key);
      return program.status;
    }
    const channel = new MessageChannel();
    program.host = await hostGridProgram({
      port: channel.port1,
      scope: this.options.client().grid(this.options.appId(), gridId),
      graphqlUrl: endpoint(this.options.graphqlUrl),
      graphqlWsUrl: endpoint(this.options.graphqlWsUrl),
      onRefused: (reason) => {
        program.status = {
          ...program.status,
          log: [...program.status.log, `[relay] refused: ${reason}`].slice(-LOG_LINES),
        };
      },
    });
    iframe.contentWindow?.postMessage(
      { source: GRID_PROGRAM_SOURCE, type: 'init', program: source, path },
      '*',
      [channel.port2],
    );
    // Give the program a moment to report `started` or an import error.
    await new Promise((resolve) => setTimeout(resolve, 750));
    return { ...program.status, log: [...program.status.log] };
  }
}

function endpoint(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value;
}
