/**
 * Hosted preview for Crowdy Studio's game editor: the draft's content layer,
 * loaded through the draft service worker and swapped into the running game.
 *
 * Started only for a player editing their own game on its hosted page (a
 * dev server previews through Vite HMR instead). It registers the worker,
 * answers the worker's questions from the draft store (the file list, a
 * file's source, the export names of a host module), and imports a fresh
 * generation of `src/game/content.ts` after each code change. Every outcome
 * lands in the content host, which is what `preview_status` reads.
 *
 * Host modules come from `virtual:construct-draft-host`, a lazy registry the
 * build writes (`constructDraftPlugin`): the framework, and every package the
 * game's content imports. A draft can import only what that build bundles.
 */
import hostModules from 'virtual:construct-draft-host';

import { previewErrorOf, type GameContentHost, type PreviewError } from './content';
import { CONTENT_ENTRY, DRAFT_WORKER_FILE, draftModuleUrl } from './draftModules';
import type { DraftChangeEvent, DraftStore } from './sdk';

const CODE_FILE = /\.(ts|tsx|mts|js|mjs|json)$/;
const RELOAD_DEBOUNCE_MS = 250;
const CONTROL_TIMEOUT_MS = 5_000;

type HostNamespace = Record<string, unknown>;

declare global {
  var __constructDraftHost: ((specifier: string) => Promise<HostNamespace>) | undefined;
  var __constructDraftEnv: Record<string, unknown> | undefined;
}

interface WorkerQuestion {
  type?: string;
  request?: 'manifest' | 'source' | 'host';
  generation?: number;
  path?: string;
  specifier?: string;
  error?: PreviewError;
}

export interface DraftLoaderOptions {
  /** The game's base URL path, with a trailing slash. */
  base: string;
  store: DraftStore;
  content: GameContentHost;
  /** What `import.meta.env` reads as in a draft module (the page's own). */
  env: Record<string, unknown>;
  log?: (line: string) => void;
}

function loadHost(specifier: string): Promise<HostNamespace> {
  const load = hostModules[specifier];
  if (!load) {
    return Promise.reject(
      new Error(
        `${specifier} is not in this build of the game; a draft can import only what the published game bundles.`,
      ),
    );
  }
  return load() as Promise<HostNamespace>;
}

function waitForControl(timeoutMs: number): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      reject(
        new Error(
          'The draft service worker did not take over this page; reload it to preview the draft.',
        ),
      );
    }, timeoutMs);
    function done(): void {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    }
    navigator.serviceWorker.addEventListener('controllerchange', done);
  });
}

export class DraftLoader {
  private generation = 0;
  private pendingRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly workerErrors = new Map<number, PreviewError[]>();
  private readonly offStore: () => void;
  private readonly onMessage = (event: MessageEvent): void => {
    void this.answer(event);
  };
  private disposed = false;

  private constructor(
    private readonly options: DraftLoaderOptions,
    private readonly registration: ServiceWorkerRegistration,
  ) {
    navigator.serviceWorker.addEventListener('message', this.onMessage);
    navigator.serviceWorker.startMessages();
    this.offStore = options.store.subscribe((event) => this.onDraftChange(event));
  }

  /** Register the worker, take over the page, and load the draft's content once. */
  static async start(options: DraftLoaderOptions): Promise<DraftLoader> {
    if (!('serviceWorker' in navigator)) {
      throw new Error(
        'This browser cannot run service workers, so the hosted game cannot preview the draft.',
      );
    }
    globalThis.__constructDraftHost = loadHost;
    globalThis.__constructDraftEnv = options.env;
    const registration = await navigator.serviceWorker.register(
      `${options.base}${DRAFT_WORKER_FILE}`,
      {
        scope: options.base,
        updateViaCache: 'none',
      },
    );
    await navigator.serviceWorker.ready;
    await waitForControl(CONTROL_TIMEOUT_MS);
    const loader = new DraftLoader(options, registration);
    loader.schedule(options.store.snapshot().revision, 0);
    return loader;
  }

  /** Stop previewing; the worker unregisters, and the page keeps what it shows. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.offStore();
    navigator.serviceWorker.removeEventListener('message', this.onMessage);
    void this.registration.unregister();
  }

  private onDraftChange(event: DraftChangeEvent): void {
    const { content } = this.options;
    content.noteRevision(event.revision);
    const reload =
      event.source === 'reload' ||
      event.source === 'rebase' ||
      event.changes.some((change) => CODE_FILE.test(change.path));
    if (reload) {
      this.schedule(event.revision, RELOAD_DEBOUNCE_MS);
      return;
    }
    if (event.changes.length > 0) {
      content.settleUnloaded(
        event.revision,
        `${event.changes.map((change) => change.path).join(', ')}: not code the running game loads; nothing to reload.`,
      );
    }
  }

  private schedule(revision: number, delayMs: number): void {
    if (this.disposed) return;
    this.pendingRevision = Math.max(this.pendingRevision, revision);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, delayMs);
  }

  private paths(): string[] {
    return this.options.store
      .snapshot()
      .entries.filter((entry) => !entry.binary)
      .map((entry) => entry.path);
  }

  private async load(): Promise<void> {
    const { base, content, log } = this.options;
    const revision = this.pendingRevision;
    const generation = ++this.generation;
    if (!this.paths().includes(CONTENT_ENTRY)) {
      content.fail(
        [
          {
            path: CONTENT_ENTRY,
            message: `This game has no ${CONTENT_ENTRY}, so its hosted page cannot preview the draft. Update the game from the template.`,
          },
        ],
        revision,
      );
      return;
    }
    let module: unknown;
    try {
      module = await import(/* @vite-ignore */ draftModuleUrl(base, generation, CONTENT_ENTRY));
    } catch (error) {
      if (generation !== this.generation) return;
      const reported = this.workerErrors.get(generation);
      content.fail(reported?.length ? reported : [previewErrorOf(error)], revision);
      return;
    } finally {
      this.workerErrors.delete(generation);
    }
    // A newer generation is loading or loaded; this one is already stale.
    if (generation !== this.generation || this.disposed) return;
    const ok = await content.replace(module, revision);
    log?.(
      `draft preview: generation ${generation} (revision ${revision}) ${ok ? 'loaded' : 'failed'}`,
    );
  }

  private async answer(event: MessageEvent): Promise<void> {
    if (
      event.source !== this.registration.active &&
      event.source !== navigator.serviceWorker.controller
    )
      return;
    const question = (event.data ?? {}) as WorkerQuestion;
    if (question.type === 'construct-draft-error') {
      if (question.generation !== undefined && question.error) {
        const errors = this.workerErrors.get(question.generation) ?? [];
        errors.push(question.error);
        this.workerErrors.set(question.generation, errors);
      }
      return;
    }
    if (question.type !== 'construct-draft') return;
    const port = event.ports[0];
    if (!port) return;
    try {
      switch (question.request) {
        case 'manifest':
          port.postMessage({ ok: true, paths: this.paths() });
          return;
        case 'source': {
          const path = String(question.path ?? '');
          const result = await this.options.store.read([path]);
          const file = result.files.find((candidate) => candidate.path === path);
          port.postMessage(
            file
              ? { ok: true, source: file.content }
              : {
                  ok: false,
                  message: `${path} is ${result.binary.includes(path) ? 'not a text file' : 'not in the draft'}.`,
                },
          );
          return;
        }
        case 'host': {
          const namespace = await loadHost(String(question.specifier ?? ''));
          port.postMessage({ ok: true, names: Object.keys(namespace) });
          return;
        }
        default:
          port.postMessage({
            ok: false,
            message: `Unknown draft request ${String(question.request)}.`,
          });
      }
    } catch (error) {
      port.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
