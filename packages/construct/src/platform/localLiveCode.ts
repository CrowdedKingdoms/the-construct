/**
 * A world without Buddy, for trying the game editor where no realtime cluster
 * runs. Set `VITE_LOCAL_LIVE_CODE=1` on the dev server: the page skips the
 * world join and the grid claim, and the world hub answers locally instead of
 * dialling ck-exec. Off unless that flag is set. The game editor itself does
 * not need it: `LIVE_DRAFT=1` turns the checkout into the draft.
 */
export function localLiveCode(): boolean {
  const env = import.meta.env as { VITE_LOCAL_LIVE_CODE?: string } | undefined;
  return env?.VITE_LOCAL_LIVE_CODE === '1';
}
