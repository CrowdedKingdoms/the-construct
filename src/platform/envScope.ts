/**
 * Browser-storage namespacing per API environment.
 *
 * A developer may point one browser profile at more than one Crowded Kingdoms
 * tier (their production app and a dev tier during SDK work). Session tokens,
 * remembered app ids and actor uuids must never leak between them, so every
 * key this game writes is suffixed with a handle derived from the API origin
 * the bundle was built against. The handle is the origin string itself, not a
 * regex over the hostname: the fleet has renamed its hosts before, and a
 * derivation that "recognises" a shape fails silently the day the shape
 * changes.
 */
import { API_HTTP_URL } from '@/platform/config';

const ENV_MARKER_KEY = 'construct:env-handle';

export function envHandleFor(apiOrigin: string): string {
  try {
    const url = new URL(apiOrigin);
    return `${url.hostname}${url.port ? `_${url.port}` : ''}`;
  } catch {
    return apiOrigin.replace(/[^a-zA-Z0-9_.-]/g, '_');
  }
}

export const ENV_HANDLE: string = envHandleFor(API_HTTP_URL);

/** Namespaced key: `<base>:<env-handle>`. */
export function envScopedKey(base: string, handle: string = ENV_HANDLE): string {
  return `${base}:${handle}`;
}

/** Keys that describe the previous environment and must not survive a switch. */
const SCOPED_LOCAL_PREFIXES = ['construct:app-id', 'construct:last-program'];

/**
 * Record which environment this profile last ran against, and drop cached
 * per-environment values when it changes. Tokens are already keyed per env by
 * their store names, so they simply become unreachable rather than deleted.
 */
export function ensureEnvScope(storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage) return;
  try {
    const previous = storage.getItem(ENV_MARKER_KEY);
    if (previous && previous !== ENV_HANDLE) {
      for (const base of SCOPED_LOCAL_PREFIXES) storage.removeItem(envScopedKey(base, previous));
    }
    storage.setItem(ENV_MARKER_KEY, ENV_HANDLE);
  } catch {
    // Storage may be unavailable (private mode quotas); the game still runs.
  }
}

export function readScoped(
  base: string,
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  try {
    return storage?.getItem(envScopedKey(base)) ?? null;
  } catch {
    return null;
  }
}

export function writeScoped(
  base: string,
  value: string | null,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    if (value === null) storage?.removeItem(envScopedKey(base));
    else storage?.setItem(envScopedKey(base), value);
  } catch {
    // ignore
  }
}
