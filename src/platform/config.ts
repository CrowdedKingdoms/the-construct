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

function trimApiOrigin(url: string): string {
  return url.replace(/\/graphql\/?$/, '').replace(/\/$/, '');
}

/**
 * The API root the bundle dials. Explicit override first; otherwise the origin
 * the SDK was published with. Never a hostname written into this repository.
 *
 * `same-origin` (or `/`) means "this page" — used when Vite proxies `/graphql`
 * so the IDE browser on a public IP and Playwright on localhost share one build.
 */
export const API_HTTP_URL: string = trimApiOrigin(
  (() => {
    const raw = envString('VITE_CROWDY_HTTP_URL');
    if (!raw) return CROWDY_DEFAULT_HTTP_ORIGIN;
    if (
      (raw === 'same-origin' || raw === '/') &&
      typeof window !== 'undefined' &&
      window.location?.origin
    ) {
      return window.location.origin;
    }
    return raw;
  })(),
);

/** The same host over WebSocket. */
export const API_WS_URL: string = API_HTTP_URL.replace(
  /^http(s?):/,
  (_m, secure: string) => `ws${secure}:`,
);

/** Which tier the SDK build targets; informational (shown in the boot card). */
export const API_TIER: string = envString('VITE_CROWDY_HTTP_URL') ? 'custom' : CROWDY_DEFAULT_TIER;

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

/**
 * When the game is opened on a public IP (IDE browser) but Studio is
 * configured as loopback, rewrite the hostname so navigation can actually
 * reach it. Path, port, and query stay intact.
 */
function rewriteLoopbackToPageHost(
  raw: string,
  pageHostname?: string | null,
): URL | null {
  try {
    const url = new URL(raw);
    const pageHost = pageHostname?.trim();
    if (pageHost && isLoopbackHost(url.hostname) && !isLoopbackHost(pageHost)) {
      url.hostname = pageHost;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Hosted sign-in URL. Same loopback rewrite as Studio origin — otherwise
 * `portal.signIn` sends the IDE browser to `127.0.0.1` and the tab goes blank.
 */
export function resolveAuthorizeUrl(input: {
  authorizeUrl?: string | null;
  pageHostname?: string | null;
}): string | undefined {
  const raw = input.authorizeUrl?.trim();
  if (!raw) return undefined;
  return rewriteLoopbackToPageHost(raw, input.pageHostname)?.toString() ?? raw;
}

/**
 * Hosted sign-in page (Studio `/authorize`). Required when `VITE_CROWDY_HTTP_URL`
 * is not a CK tier host — CrowdyJS cannot derive Studio from a same-origin
 * proxy or a raw IP. Leave unset to use the SDK's tier convention.
 */
export const AUTHORIZE_URL: string | undefined = resolveAuthorizeUrl({
  authorizeUrl: envString('VITE_AUTHORIZE_URL'),
  pageHostname: typeof window !== 'undefined' ? window.location.hostname : null,
});

/**
 * Studio origin for in-game links. Explicit `VITE_STUDIO_URL` wins; otherwise
 * the origin of the hosted-sign-in URL. When that URL is loopback and the
 * page is not (public-IP IDE against a local stack), the page hostname is
 * substituted so Wallet opens the Studio the player can actually reach.
 * Never a hostname written into this repository.
 */
export function resolveStudioOrigin(input: {
  authorizeUrl?: string | null;
  studioUrl?: string | null;
  pageHostname?: string | null;
}): string | null {
  const explicit = input.studioUrl?.trim();
  if (explicit) return originOf(explicit);
  const authorize = input.authorizeUrl?.trim();
  if (!authorize) return null;
  return rewriteLoopbackToPageHost(authorize, input.pageHostname)?.origin ?? null;
}

export const STUDIO_ORIGIN: string | null = resolveStudioOrigin({
  authorizeUrl: envString('VITE_AUTHORIZE_URL'),
  studioUrl: envString('VITE_STUDIO_URL'),
  pageHostname: typeof window !== 'undefined' ? window.location.hostname : null,
});

/** Player wallet page in Studio. Null when we cannot derive Studio's origin. */
export const STUDIO_WALLET_URL: string | null = STUDIO_ORIGIN
  ? `${STUDIO_ORIGIN}/account/wallet`
  : null;

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
