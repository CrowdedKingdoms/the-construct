/**
 * Opt-in local session for live-coding a bound game.
 *
 * Set `VITE_LOCAL_LIVE_CODE=1` on the dev server. The page then skips the Buddy
 * join and the grid claim, and the world hub answers locally instead of
 * dialling ck-exec. Off unless that flag is set.
 */
export function localLiveCode(): boolean {
  const env = import.meta.env as { VITE_LOCAL_LIVE_CODE?: string } | undefined;
  return env?.VITE_LOCAL_LIVE_CODE === '1';
}
