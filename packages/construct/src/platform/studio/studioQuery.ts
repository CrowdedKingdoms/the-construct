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
