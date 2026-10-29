/**
 * The game editor's slice of CrowdyJS 18.23 (`@crowdedkingdoms/crowdyjs/crowdy-studio`):
 * the draft-store contract, the hosted store and its storage.
 *
 * The types are the SDK's own. The classes are looked up at runtime, so a page
 * bundled with an SDK that predates them opens a bound project in the mod
 * editor instead of failing to load.
 */
import * as studio from '@crowdedkingdoms/crowdyjs/crowdy-studio';
import type {
  GitHubDraftTransport,
  MountCrowdyStudioOptions,
} from '@crowdedkingdoms/crowdyjs/crowdy-studio';

export type {
  DraftChangeEvent,
  DraftCommitResult,
  DraftConflict,
  DraftDeleteResult,
  DraftEntry,
  DraftErrorCode,
  DraftPrecondition,
  DraftReadResult,
  DraftSnapshot,
  DraftSource,
  DraftStore,
  DraftWriteResult,
} from '@crowdedkingdoms/crowdyjs/crowdy-studio';

/** What the Studio controller's `draftStore` option is given. */
export type DraftProject = Parameters<NonNullable<MountCrowdyStudioOptions['draftStore']>>[0];

/** The commit path of the SDK's GitHub transport (`game.crowdyStudioGitHub`). */
export type DraftCommitTransport = Pick<GitHubDraftTransport, 'commitFiles'>;

export type LiveCodeSdk = Pick<
  typeof studio,
  'GitHubDraftStore' | 'IndexedDbDraftOverlayStorage' | 'DraftError' | 'isRepoPath'
>;

/** The SDK's game-editor classes, or null when the installed SDK predates them. */
export function liveCodeSdk(): LiveCodeSdk | null {
  const sdk = studio as Partial<LiveCodeSdk>;
  return typeof sdk.GitHubDraftStore === 'function' &&
    typeof sdk.IndexedDbDraftOverlayStorage === 'function' &&
    typeof sdk.DraftError === 'function' &&
    typeof sdk.isRepoPath === 'function'
    ? (sdk as LiveCodeSdk)
    : null;
}
