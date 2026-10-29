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

/**
 * The Studio project the page was asked to open (`project=<id>`, from Crowdy
 * Studio's Live code link), or null. Only an id-shaped value counts.
 */
export function requestedProject(search: string): string | null {
  const value = new URLSearchParams(search.replace(/^\?/, '')).get('project')?.trim();
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}
