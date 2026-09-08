# Changelog

## 0.2.0 — 2026-09-08

CrowdyJS `15.5.0` (dev build `15.5.0-dev.1`): webcam video and the actor-left
notice, both wired as platform code.

- `src/platform/media/WebcamService.ts`: proximity webcam. 128×96 JPEG at
  10 fps through the SDK's `sendVideoFrame` (fragmented into `sendVideoPacket`s,
  `distance` 1); receive through `VideoFrameAssembler` to per-uuid
  `ImageBitmap`s (`frame` / `ended` events). Needs `use_video_chat`, which
  Setup now grants on the Constructor tier; a refusal is reported once and
  capture stops.
- Player-left: `NetworkManager.on('actorLeft')` (and the World Stores lane's
  `onLeave` as fallback) end a sender's stream and free its texture at once
  rather than after the 12 s stale reaper.
- Holodeck: a face plane at eye height on each remote capsule shows their
  camera while frames arrive; disposed with the avatar. HUD: `Camera (B)`
  toggle and a mirrored self-preview. Paint: a ring on the disc while a
  player's camera is on (no video in the 2D program by design).
- `Permissions-Policy: camera=(self), microphone=()` joins the header set, in
  Vite and every HOSTING recipe; `security-headers.test.mjs` asserts it.
- Tests: `videoFrames.test.ts` (receive path over the real SDK fragmenter);
  Playwright runs with Chromium's fake camera and the live smoke toggles it.
- Docs: PLATFORM-MAP (webcam and player-left rows), ARCHITECTURE,
  NEW-GAME-CHECKLIST, MODDING (no camera for mods), HOSTING, README.

## 0.1.0 — 2026-09-07

First release of the starter.

- Engine-agnostic platform layer over CrowdyJS 15.4: two-token sign-in and app
  entry with datacenter routing and token rotation, World Stores presence and
  chunks, typed save state, proximity chat.
- `GameScene` adapter contract with a frame loop and scene router; two
  renderers driven by one session: a three.js holodeck hub and a pixi.js
  shared-canvas program with persisted voxels.
- Server-authoritative game model as Game Kit blueprints (progression,
  leaderboards) plus a hand-authored catalog, world singleton, automation and
  claim registry; idempotent seeding.
- Crowdy Studio embedded with SERVER and CLIENT mods: chunk claims, exact
  effective permissions, the same-origin glue worker, an allowlisted
  `world_read` host-call router, the text HUD, visitor trust and attachment
  lifecycle, and a `crossOriginIsolated` check with an on-screen banner.
- Setup wizard (browser) and `npm run setup` (shell) sharing one idempotent
  onboarding module: organization, free app, Constructor tier, visitor run
  keys, claim policy, model, Studio starter files.
- Security headers module wired into Vite dev/preview and documented per host.
- Tests: vitest unit suite, `node --test` CSP tests, Playwright smoke; CI on
  pull requests and the three tier branches with a tier-aligned SDK pin check.
