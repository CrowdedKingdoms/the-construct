/**
 * The game editor's draft on a local dev server: the game's own checkout,
 * through `liveDraftPlugin` (node/live-draft.mjs). Vite HMR previews each
 * change through the content layer; edits made on disk arrive as
 * `construct:draft` events. Commit publishes the dirty files as one GitHub
 * commit through the SDK's transport (as the hosted store does), then moves
 * the checkout's HEAD to it.
 */
import type {
  DraftChangeEvent,
  DraftCommitResult,
  DraftCommitTransport,
  DraftConflict,
  DraftDeleteResult,
  DraftErrorCode,
  DraftPrecondition,
  DraftReadResult,
  DraftSnapshot,
  DraftStore,
  DraftWriteResult,
  LiveCodeSdk,
} from './sdk';

const TOKEN_META = 'construct-live-draft';
const READ_BATCH = 100;

/** The token a dev server with the live draft on puts in this page, or null. */
export function devServerDraftToken(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content || null;
}

interface ServerDraftEvent {
  revision: number;
  changes: Array<{ path: string; hash: string | null }>;
  source: DraftChangeEvent['source'];
  writer?: string;
  baseCommitSha?: string;
}

/** The slice of Vite's `import.meta.hot` the store listens on. */
export interface DraftHotChannel {
  on(event: 'construct:draft', listener: (data: ServerDraftEvent) => void): void;
  off?(event: 'construct:draft', listener: (data: ServerDraftEvent) => void): void;
}

export interface DevServerDraftStoreOptions {
  /** The dev server's base path, with a trailing slash. */
  base: string;
  token: string;
  appId: string;
  projectId: string;
  /** The SDK's GitHub transport (`game.crowdyStudioGitHub`); its `commitFiles` arrived in CrowdyJS 18.23. */
  transport: object;
  sdk: Pick<LiveCodeSdk, 'DraftError'>;
  hot?: DraftHotChannel;
  fetch?: typeof fetch;
}

export class DevServerDraftStore implements DraftStore {
  readonly kind = 'dev-server';
  private state: DraftSnapshot = {
    baseCommitSha: null,
    revision: 0,
    entries: [],
    deleted: [],
    truncated: false,
  };
  private readonly listeners = new Set<(event: DraftChangeEvent) => void>();
  private readonly writer = Math.random().toString(36).slice(2);
  private readonly onServer = (data: ServerDraftEvent): void => {
    void this.follow(data);
  };
  private disposed = false;

  constructor(private readonly options: DevServerDraftStoreOptions) {
    options.hot?.on('construct:draft', this.onServer);
  }

  private error(
    code: DraftErrorCode,
    message: string,
    conflicts: readonly DraftConflict[] = [],
  ): Error {
    return new this.options.sdk.DraftError(code, message, conflicts);
  }

  private async api<T>(action: string, body?: Record<string, unknown>): Promise<T> {
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.base}__live-draft/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: {
          'X-Construct-Draft-Token': this.options.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw this.error(
        'DRAFT_UNAVAILABLE',
        `The dev server is unreachable (${(error as Error).message}).`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as {
      code?: DraftErrorCode;
      message?: string;
    };
    if (!response.ok) {
      throw this.error(
        payload.code ?? 'DRAFT_UNAVAILABLE',
        payload.message ?? `The dev server answered ${response.status}.`,
      );
    }
    return payload as T;
  }

  private emit(event: DraftChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async load(): Promise<DraftSnapshot> {
    this.state = await this.api<DraftSnapshot>('tree');
    return this.state;
  }

  snapshot(): DraftSnapshot {
    return this.state;
  }

  async read(paths: readonly string[]): Promise<DraftReadResult> {
    const out: DraftReadResult = { files: [], missing: [], binary: [] };
    for (let i = 0; i < paths.length; i += READ_BATCH) {
      const part = await this.api<DraftReadResult>('read', {
        paths: paths.slice(i, i + READ_BATCH),
      });
      out.files.push(...part.files);
      out.missing.push(...part.missing);
      out.binary.push(...part.binary);
    }
    return out;
  }

  async write(
    path: string,
    content: string,
    options: { source: 'player' | 'agent'; precondition?: DraftPrecondition },
  ): Promise<DraftWriteResult> {
    const result = await this.api<DraftWriteResult & { dirty: boolean }>('write', {
      path,
      content,
      source: options.source,
      writer: this.writer,
      ...(options.precondition ? { precondition: options.precondition } : {}),
    });
    const size = new TextEncoder().encode(content).byteLength;
    this.state = {
      ...this.state,
      revision: result.revision,
      entries: [
        ...this.state.entries.filter((entry) => entry.path !== path),
        { path, hash: result.hash, size, binary: false, dirty: result.dirty },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
      deleted: this.state.deleted.filter((deleted) => deleted !== path),
    };
    this.emit({
      revision: result.revision,
      baseCommitSha: this.state.baseCommitSha,
      changes: [{ path, hash: result.hash }],
      source: options.source,
    });
    return {
      path: result.path,
      hash: result.hash,
      previousHash: result.previousHash,
      revision: result.revision,
    };
  }

  async remove(
    path: string,
    options: { source: 'player' | 'agent'; precondition?: { kind: 'ifHash'; hash: string } },
  ): Promise<DraftDeleteResult> {
    const result = await this.api<DraftDeleteResult & { inHead: boolean }>('delete', {
      path,
      source: options.source,
      writer: this.writer,
      ...(options.precondition ? { precondition: options.precondition } : {}),
    });
    this.state = {
      ...this.state,
      revision: result.revision,
      entries: this.state.entries.filter((entry) => entry.path !== path),
      deleted: result.inHead
        ? [...new Set([...this.state.deleted, path])].sort()
        : this.state.deleted,
    };
    this.emit({
      revision: result.revision,
      baseCommitSha: this.state.baseCommitSha,
      changes: [{ path, hash: null }],
      source: options.source,
    });
    return { path: result.path, previousHash: result.previousHash, revision: result.revision };
  }

  async discard(paths?: readonly string[]): Promise<void> {
    await this.api('discard', { writer: this.writer, ...(paths ? { paths: [...paths] } : {}) });
    await this.load();
    this.emit({
      revision: this.state.revision,
      baseCommitSha: this.state.baseCommitSha,
      changes: [],
      source: 'reload',
    });
  }

  async commit(request: {
    message: string;
    paths?: readonly string[];
  }): Promise<DraftCommitResult> {
    const transport = this.options.transport as Partial<DraftCommitTransport>;
    const commitFiles = transport.commitFiles?.bind(transport);
    if (!commitFiles) {
      throw this.error(
        'DRAFT_UNAVAILABLE',
        'This page’s CrowdyJS cannot commit several files at once; update it to 18.23 or later.',
      );
    }
    const tree = await this.load();
    const wanted = (path: string) => !request.paths || request.paths.includes(path);
    const written = tree.entries.filter((entry) => entry.dirty && wanted(entry.path));
    const deleted = tree.deleted.filter(wanted);
    if (written.length + deleted.length === 0)
      throw this.error('DRAFT_NOT_FOUND', 'The draft has nothing to commit.');
    const binary = written.filter((entry) => entry.binary).map((entry) => entry.path);
    if (binary.length > 0) {
      throw this.error(
        'DRAFT_PATH_REFUSED',
        `Studio commits text only; commit ${binary.join(', ')} with git.`,
      );
    }
    if (!tree.baseCommitSha)
      throw this.error('DRAFT_UNAVAILABLE', 'The checkout has no commit to build on.');
    const texts = await this.read(written.map((entry) => entry.path));
    let result: Awaited<ReturnType<DraftCommitTransport['commitFiles']>>;
    try {
      result = await commitFiles({
        appId: this.options.appId,
        projectId: this.options.projectId,
        message: request.message,
        expectedCommitSha: tree.baseCommitSha,
        changes: [
          ...texts.files.map((file) => ({ path: file.path, content: file.content })),
          ...deleted.map((path) => ({ path, delete: true })),
        ],
      });
    } catch (error) {
      const code =
        (error as { extensions?: { code?: string }; code?: string }).code ??
        (error as { errors?: Array<{ extensions?: { code?: string } }> }).errors?.[0]?.extensions
          ?.code;
      if (
        code === 'GITHUB_STALE_SHA' ||
        /GITHUB_STALE_SHA/.test(String((error as Error).message))
      ) {
        throw this.error(
          'DRAFT_CONFLICT',
          'The bound branch on GitHub moved past this checkout. Pull it (git pull), then commit again.',
        );
      }
      throw error;
    }
    try {
      await this.api('sync', { commitSha: result.commitSha, writer: this.writer });
    } catch (error) {
      console.warn(
        `Committed ${result.commitSha.slice(0, 7)}; the checkout did not follow: ${(error as Error).message}`,
      );
    }
    await this.load();
    const committed = [...result.written, ...result.deleted];
    this.emit({
      revision: this.state.revision,
      baseCommitSha: this.state.baseCommitSha,
      changes: committed.map((path) => ({
        path,
        hash: this.state.entries.find((entry) => entry.path === path)?.hash ?? null,
      })),
      source: 'commit',
    });
    return { commitSha: result.commitSha, committed, baseCommitSha: result.commitSha };
  }

  conflicts(): readonly DraftConflict[] {
    return [];
  }

  async resolveConflict(): Promise<void> {
    throw this.error(
      'DRAFT_UNAVAILABLE',
      'A local checkout settles conflicts with git (pull, then commit again).',
    );
  }

  subscribe(listener: (event: DraftChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.options.hot?.off?.('construct:draft', this.onServer);
    this.listeners.clear();
  }

  /** A change the dev server announced: another tab's write, an edit on disk, a commit or a discard. */
  private async follow(data: ServerDraftEvent): Promise<void> {
    if (this.disposed || data.writer === this.writer) return;
    await this.load().catch(() => undefined);
    if (this.disposed) return;
    this.emit({
      revision: this.state.revision,
      baseCommitSha: this.state.baseCommitSha,
      changes: data.changes,
      source: data.changes.length === 0 ? 'reload' : data.source,
    });
  }
}
