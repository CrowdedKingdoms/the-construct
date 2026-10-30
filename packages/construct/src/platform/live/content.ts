/**
 * The game's content layer, as the host sees it.
 *
 * A game's `src/game/content.ts` default-exports a `GameContent`: its scenes,
 * where players start, and the programs a scene can be. `main.ts` and the
 * framework are the host; they load the content once from the build, and
 * again whenever Crowdy Studio's game editor changes it: Vite HMR on a local
 * dev server, the draft service worker on a hosted game (`./draftLoader`).
 * Only what this module reaches is previewable without a rebuild.
 *
 * The host also answers `preview_status`: which draft revision the running
 * world reflects, and the errors it hit loading it.
 */
import type { SceneFactory } from '../../engine/GameScene';

/** The contract version `src/game/content.ts` declares as `contentApi`. */
export const CONTENT_API = 1;

export interface ContentSpawn {
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

export interface ContentProgram {
  /** The byte every pose carries while a player is in it (1-255; 0 is home). */
  readonly programId: number;
  /** The scene the router loads for it. */
  readonly sceneId: string;
}

export interface GameContent {
  readonly contentApi: typeof CONTENT_API;
  /** Scene id -> a factory for a fresh scene. */
  readonly scenes: Readonly<Record<string, SceneFactory>>;
  /** The scene a player starts in, and where. */
  readonly home: { readonly sceneId: string; readonly spawn: ContentSpawn };
  /** The programs scenes can be, by the id every pose carries. */
  readonly programs: readonly ContentProgram[];
}

export interface PreviewError {
  /** Repository path, when the error names one. */
  path?: string;
  line?: number;
  column?: number;
  message: string;
}

/** What `preview_status` reports (the shape of the Studio bridge's `preview.status`). */
export interface PreviewStatus {
  /** Draft revision the running world reflects. */
  revision: number;
  ok: boolean;
  scene?: string;
  errors: PreviewError[];
  note?: string;
}

/** A module object or its default export, checked against the contract. */
export function assertGameContent(value: unknown, where = 'src/game/content.ts'): GameContent {
  const candidate =
    value && typeof value === 'object' && 'default' in value
      ? (value as { default: unknown }).default
      : value;
  const fail = (why: string): never => {
    throw new Error(`${where}: ${why}`);
  };
  if (!candidate || typeof candidate !== 'object') fail('must default-export the game content.');
  const content = candidate as Partial<GameContent>;
  if (content.contentApi !== CONTENT_API) {
    fail(
      `declares contentApi ${String(content.contentApi)}; this host loads contentApi ${CONTENT_API}. Update the game from the template.`,
    );
  }
  const scenes = content.scenes;
  if (!scenes || typeof scenes !== 'object') fail('has no scenes.');
  for (const [id, factory] of Object.entries(scenes as Record<string, unknown>)) {
    if (typeof factory !== 'function') fail(`scene "${id}" is not a factory function.`);
  }
  const home = content.home;
  if (!home || typeof home.sceneId !== 'string' || !(home.sceneId in scenes!)) {
    fail('home.sceneId must name one of its scenes.');
  }
  const spawn = home!.spawn;
  if (!spawn || ![spawn.x, spawn.y, spawn.z].every((n) => typeof n === 'number')) {
    fail('home.spawn needs numeric x, y and z.');
  }
  if (!Array.isArray(content.programs)) fail('programs must be a list.');
  const ids = new Set<number>();
  for (const program of content.programs as ContentProgram[]) {
    if (!Number.isInteger(program.programId) || program.programId < 1 || program.programId > 255) {
      fail(`program ${String(program.programId)} needs an id from 1 to 255.`);
    }
    if (ids.has(program.programId)) fail(`program id ${program.programId} is used twice.`);
    ids.add(program.programId);
    if (!(program.sceneId in scenes!)) {
      fail(
        `program ${program.programId} names scene "${program.sceneId}", which it does not register.`,
      );
    }
  }
  return content as GameContent;
}

const DRAFT_FRAME = /__draft\/g\d+\/([^\s?:)]+)(?:\?[^\s:)]*)?:(\d+):(\d+)/;
const DEV_FRAME =
  /https?:\/\/[^/\s]+\/(?:[^\s:)]*?\/)?((?:src|model)\/[^\s?:)]+)(?:\?[^\s:)]*)?:(\d+):(\d+)/;

/** The first repository frame of an error, with its message. */
export function previewErrorOf(error: unknown): PreviewError {
  const preview =
    error && typeof error === 'object' && 'preview' in error
      ? (error as { preview: unknown }).preview
      : undefined;
  if (
    preview &&
    typeof preview === 'object' &&
    typeof (preview as PreviewError).message === 'string'
  ) {
    return { ...(preview as PreviewError) };
  }
  if (error && typeof error === 'object' && 'path' in error && 'message' in error) {
    const known = error as PreviewError;
    if (typeof known.message === 'string') return { ...known };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const match = DRAFT_FRAME.exec(`${message}\n${stack}`) ?? DEV_FRAME.exec(`${message}\n${stack}`);
  if (!match) return { message };
  return { path: match[1], line: Number(match[2]), column: Number(match[3]), message };
}

interface Outcome {
  ok: boolean;
  errors: PreviewError[];
  note?: string;
}

/**
 * The running game's content, swapped in place when the draft changes. The
 * host calls `replace` with each new module; `main.ts` supplies the remount.
 * A failed load or mount keeps the previous content on screen.
 */
export class GameContentHost {
  private content: GameContent;
  private remount: ((content: GameContent) => Promise<void>) | null = null;
  private sceneOf: () => string | undefined = () => undefined;
  private latest = 0;
  private settled = 0;
  private outcome: Outcome = { ok: true, errors: [] };
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(content: GameContent) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumps on every content swap. */
  generation = 0;

  constructor(initial: unknown) {
    this.content = assertGameContent(initial);
  }

  get current(): GameContent {
    return this.content;
  }

  /** `main.ts`: how new content reaches the screen, and which scene is showing. */
  bind(options: {
    remount: (content: GameContent) => Promise<void>;
    scene: () => string | undefined;
  }): void {
    this.remount = options.remount;
    this.sceneOf = options.scene;
  }

  programById(programId: number): ContentProgram | undefined {
    return this.content.programs.find((program) => program.programId === programId);
  }

  /** Called after each swap, once the remount finished. */
  onChange(listener: (content: GameContent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A draft revision the page now holds; `preview_status` waits for it. */
  noteRevision(revision: number): void {
    this.latest = Math.max(this.latest, revision);
  }

  /** The revision changed nothing the running world loads: settle it with a note. */
  settleUnloaded(revision: number, note: string): void {
    this.noteRevision(revision);
    this.settle(revision, { ok: true, errors: [], note });
  }

  /** A load failed before there was content to swap (a transform or import error). */
  fail(errors: PreviewError[], revision = this.latest): void {
    this.noteRevision(revision);
    this.settle(revision, { ok: false, errors });
  }

  /** Swap in a freshly loaded content module. Never throws: the outcome is the preview status. */
  replace(next: unknown, revision = this.latest): Promise<boolean> {
    const run = this.chain.then(async () => {
      this.noteRevision(revision);
      let content: GameContent;
      try {
        content = assertGameContent(next);
      } catch (error) {
        this.settle(revision, { ok: false, errors: [previewErrorOf(error)] });
        return false;
      }
      const previous = this.content;
      this.content = content;
      this.generation += 1;
      try {
        await this.remount?.(content);
      } catch (error) {
        this.content = previous;
        const errors = [previewErrorOf(error)];
        try {
          await this.remount?.(previous);
        } catch (restoreError) {
          errors.push(previewErrorOf(restoreError));
        }
        this.settle(revision, { ok: false, errors });
        return false;
      }
      this.settle(revision, { ok: true, errors: [] });
      for (const listener of this.listeners) listener(content);
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** What the running world reflects, once it caught up with `afterRevision` (or the newest known). */
  async status(
    params: { afterRevision?: number; timeoutMs?: number } = {},
  ): Promise<PreviewStatus> {
    const target = Math.max(params.afterRevision ?? 0, this.latest);
    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 10_000, 0), 60_000);
    if (this.settled < target) {
      await new Promise<void>((resolve) => {
        const done = () => {
          if (this.settled < target) return;
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(done);
          resolve();
        }, timeoutMs);
        this.waiters.add(done);
      });
    }
    const scene = this.sceneOf();
    if (this.settled < target) {
      return {
        revision: this.settled,
        ok: false,
        ...(scene ? { scene } : {}),
        errors: [],
        note: `The world has not reloaded draft revision ${target} yet. A file outside the content layer (src/game/content.ts and what it imports) needs a rebuild, or the reload is still running.`,
      };
    }
    return {
      revision: this.settled,
      ok: this.outcome.ok,
      ...(scene ? { scene } : {}),
      errors: this.outcome.errors,
      ...(this.outcome.note ? { note: this.outcome.note } : {}),
    };
  }

  private settle(revision: number, outcome: Outcome): void {
    if (revision < this.settled) return;
    this.settled = revision;
    this.outcome = outcome;
    for (const waiter of [...this.waiters]) waiter();
  }
}
