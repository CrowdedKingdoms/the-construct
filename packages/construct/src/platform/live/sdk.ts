/**
 * The game editor's slice of CrowdyJS 18.23 (`@crowdedkingdoms/crowdyjs/crowdy-studio`):
 * the draft-store contract, the hosted store and its storage.
 *
 * The template pins an older SDK until 18.23 publishes, so the types are
 * mirrored here and the classes are looked up at runtime: with an older SDK
 * the game editor says it is unavailable instead of failing the build. When
 * the pin reaches 18.23, this file re-exports the SDK's own declarations.
 */
import * as studio from '@crowdedkingdoms/crowdyjs/crowdy-studio';

export type DraftSource = 'player' | 'agent' | 'commit' | 'rebase' | 'reload';

export interface DraftEntry {
  path: string;
  hash: string;
  size: number;
  binary: boolean;
  dirty: boolean;
}

export interface DraftSnapshot {
  baseCommitSha: string | null;
  revision: number;
  entries: DraftEntry[];
  deleted: string[];
  truncated: boolean;
}

export interface DraftChangeEvent {
  revision: number;
  baseCommitSha: string | null;
  changes: Array<{ path: string; hash: string | null }>;
  source: DraftSource;
}

export type DraftPrecondition = { kind: 'createIfAbsent' } | { kind: 'ifHash'; hash: string };

export interface DraftReadResult {
  files: Array<{ path: string; hash: string; content: string }>;
  missing: string[];
  binary: string[];
}

export interface DraftWriteResult {
  path: string;
  hash: string;
  previousHash: string | null;
  revision: number;
}

export interface DraftDeleteResult {
  path: string;
  previousHash: string;
  revision: number;
}

export interface DraftCommitResult {
  commitSha: string;
  committed: string[];
  baseCommitSha: string;
}

export interface DraftConflict {
  path: string;
  base: string | null;
  theirs: string | null;
  ours: string | null;
}

export const DRAFT_ERROR_CODES = {
  stale: 'DRAFT_STALE',
  notFound: 'DRAFT_NOT_FOUND',
  refused: 'DRAFT_PATH_REFUSED',
  tooLarge: 'DRAFT_TOO_LARGE',
  conflict: 'DRAFT_CONFLICT',
  declined: 'DRAFT_DECLINED',
  unavailable: 'DRAFT_UNAVAILABLE',
} as const;

export type DraftErrorCode = (typeof DRAFT_ERROR_CODES)[keyof typeof DRAFT_ERROR_CODES];

export interface DraftStore {
  readonly kind: string;
  load(): Promise<DraftSnapshot>;
  snapshot(): DraftSnapshot;
  read(paths: readonly string[]): Promise<DraftReadResult>;
  write(
    path: string,
    content: string,
    options: { source: 'player' | 'agent'; precondition?: DraftPrecondition },
  ): Promise<DraftWriteResult>;
  remove(
    path: string,
    options: { source: 'player' | 'agent'; precondition?: { kind: 'ifHash'; hash: string } },
  ): Promise<DraftDeleteResult>;
  discard(paths?: readonly string[]): Promise<void>;
  commit(request: { message: string; paths?: readonly string[] }): Promise<DraftCommitResult>;
  conflicts(): readonly DraftConflict[];
  resolveConflict(path: string, keep: 'mine' | 'theirs'): Promise<void>;
  subscribe(listener: (event: DraftChangeEvent) => void): () => void;
  dispose(): void;
}

/** What the Studio controller's `draftStore` option is given. */
export interface DraftProject {
  appId: string;
  projectId: string;
  githubSha: string;
}

/** The commit path of the SDK's GitHub transport (`game.crowdyStudioGitHub`). */
export interface DraftCommitTransport {
  commitFiles(input: {
    appId: string;
    projectId: string;
    message: string;
    expectedCommitSha: string;
    changes: Array<{ path: string; content?: string; delete?: boolean }>;
  }): Promise<{ commitSha: string; parentSha: string; written: string[]; deleted: string[] }>;
}

export interface LiveCodeSdk {
  GitHubDraftStore: new (options: {
    transport: unknown;
    appId: string;
    projectId: string;
    baseCommitSha: string;
    storage?: unknown;
  }) => DraftStore;
  IndexedDbDraftOverlayStorage: new () => unknown;
  DraftError: new (
    code: DraftErrorCode,
    message: string,
    conflicts?: readonly DraftConflict[],
  ) => Error & {
    readonly code: DraftErrorCode;
  };
  isRepoPath(path: string): boolean;
}

/** The SDK's game-editor classes, or null when the installed SDK predates them. */
export function liveCodeSdk(): LiveCodeSdk | null {
  const sdk = studio as unknown as Partial<LiveCodeSdk>;
  return typeof sdk.GitHubDraftStore === 'function' &&
    typeof sdk.IndexedDbDraftOverlayStorage === 'function' &&
    typeof sdk.DraftError === 'function' &&
    typeof sdk.isRepoPath === 'function'
    ? (sdk as LiveCodeSdk)
    : null;
}
