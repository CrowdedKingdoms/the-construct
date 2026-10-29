import { envScopedKey } from '../envScope';

/**
 * Whether the dock should open when the page loads.
 *
 * `studio=open` asks for it. No `studio` parameter keeps today's behavior,
 * which is open. Any other value leaves it closed.
 */
export function wantsStudioOpen(search: string): boolean {
  const value = new URLSearchParams(search.replace(/^\?/, '')).get('studio');
  return value === null || value === 'open';
}

const PROJECT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REMEMBERED_PROJECT_KEY = 'construct:requested-project';

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function tabStorage(): TabStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    // A frame denied storage throws on the read itself.
    return undefined;
  }
}

function projectIn(search: string): string | null {
  const value = new URLSearchParams(search.replace(/^\?/, '')).get('project')?.trim();
  return value && PROJECT_PATTERN.test(value) ? value : null;
}

/**
 * Keep the project the page was asked to open for the rest of this tab's
 * session. A hosted sign-in returns to the bare page address, without the
 * query that named it, so call this before anything can send the page there.
 */
export function rememberRequestedProject(
  search: string,
  storage: TabStorage | undefined = tabStorage(),
): void {
  const project = projectIn(search);
  if (!project) return;
  try {
    storage?.setItem(envScopedKey(REMEMBERED_PROJECT_KEY), project);
  } catch {
    // Storage may be unavailable; after a sign-in the editor then opens no project.
  }
}

function takeRemembered(storage: TabStorage | undefined): string | null {
  const key = envScopedKey(REMEMBERED_PROJECT_KEY);
  try {
    const kept = storage?.getItem(key) ?? null;
    storage?.removeItem(key);
    return kept !== null && PROJECT_PATTERN.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

/**
 * The Studio project the page was asked to open (`project=<id>`, from Crowdy
 * Studio's Live code link), or null. Only an id-shaped value counts. Without
 * one on the address, the one `rememberRequestedProject` kept before a sign-in.
 * Either way the kept one is used up, so it opens once.
 */
export function requestedProject(
  search: string,
  storage: TabStorage | undefined = tabStorage(),
): string | null {
  const kept = takeRemembered(storage);
  return projectIn(search) ?? kept;
}
