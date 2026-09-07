/**
 * Build-time and runtime configuration for The Construct.
 *
 * The starter needs almost nothing configured: the installed CrowdyJS build
 * already knows the public API origin for its tier, and the app id can come
 * from the Setup wizard instead of an env file. Everything here is therefore
 * optional and resolved in a documented order, and the pure functions are
 * unit-tested in `config.test.ts`.
 */
import { CROWDY_DEFAULT_HTTP_ORIGIN, CROWDY_DEFAULT_TIER } from '@crowdedkingdoms/crowdyjs';

function envString(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

/**
 * The API root the bundle dials. Explicit override first; otherwise the origin
 * the SDK was published with. Never a hostname written into this repository.
 */
export const API_HTTP_URL: string = (
  envString('VITE_CROWDY_HTTP_URL') ?? CROWDY_DEFAULT_HTTP_ORIGIN
)
  .replace(/\/graphql\/?$/, '')
  .replace(/\/$/, '');

/** The same host over WebSocket. */
export const API_WS_URL: string = API_HTTP_URL.replace(
  /^http(s?):/,
  (_m, secure: string) => `ws${secure}:`,
);

/** Which tier the SDK build targets; informational (shown in the boot card). */
export const API_TIER: string = envString('VITE_CROWDY_HTTP_URL') ? 'custom' : CROWDY_DEFAULT_TIER;

/** CLIENT-target Crowdy Studio mods (browser sandbox). A fork can turn these off. */
export const CLIENT_MODS_ENABLED: boolean = envFlag('VITE_CONSTRUCT_CLIENT_MODS', true);

/** App-token rotation cadence. Tokens live ~30 minutes; rotate well before. */
export const APP_TOKEN_REFRESH_MS: number =
  Math.max(60, Number(envString('VITE_APP_TOKEN_REFRESH_SECONDS') ?? 1200)) * 1000;

/** Retry a failed rotation sooner than the full interval. */
export const APP_TOKEN_REFRESH_RETRY_MS = 30_000;

/** Fixed spatial parameters shared by every scene. */
export const CHUNK_SIZE = 16;
export const REPLICATION_DISTANCE = 4;
export const ACTOR_SYNC_INTERVAL_MS = 200;
export const STALE_ACTOR_TIMEOUT_MS = 12_000;

export const GAME_NAME = 'The Construct';

// ---------------------------------------------------------------------------
// App id resolution
// ---------------------------------------------------------------------------

export const APP_ID_STORAGE_KEY = 'construct:app-id';

export interface AppIdSources {
  /** `window.location.search` (or any query string). */
  search?: string | null;
  /** The env-scoped storage the wizard writes to. */
  stored?: string | null;
  /** `VITE_APP_ID` as built. */
  env?: string | null;
}

export type AppIdResolution =
  { appId: string; source: 'query' | 'storage' | 'env' } | { appId: null; source: 'none' };

const APP_ID_PATTERN = /^\d{1,20}$/;

function validAppId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && APP_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Resolution order, most explicit first:
 *  1. `?app=<id>` in the URL (share a link to a specific app),
 *  2. the id the Setup wizard remembered in this browser (env-scoped),
 *  3. `VITE_APP_ID` baked into the build,
 *  4. none — the boot flow opens the Setup wizard.
 */
export function resolveAppId(sources: AppIdSources): AppIdResolution {
  const fromQuery = validAppId(
    sources.search ? new URLSearchParams(sources.search).get('app') : null,
  );
  if (fromQuery) return { appId: fromQuery, source: 'query' };
  const fromStorage = validAppId(sources.stored);
  if (fromStorage) return { appId: fromStorage, source: 'storage' };
  const fromEnv = validAppId(sources.env);
  if (fromEnv) return { appId: fromEnv, source: 'env' };
  return { appId: null, source: 'none' };
}

/** The env-baked app id, if any (exposed for the boot flow + the wizard UI). */
export const BUILD_APP_ID: string | null = validAppId(envString('VITE_APP_ID'));
