# Changelog

## 0.8.0 — 2026-09-14

Publish to Crowdy Games. CrowdyJS `17.2.0-dev.1` (ck-api v2.1.0).

- `npm run publish [-- --slug my-game]` (`scripts/publish.mjs`): sign in, claim
  the hosting slug, build, upload `dist/`, and print the play URL. The game is
  reached at `https://<games host>/<slug>/` (a first-party shell) and executes
  on `https://<slug>.<content host>`, its own origin, behind the same headers
  `docs/HOSTING.md` asks a self-hoster to serve.
- Hosted sign-in under the shell needs nothing from this repo: the SDK's
  `EmbeddedHost` asks the shell to navigate and uses the shell page as
  `redirect_uri`; the code is relayed into the frame.
- `security-headers.mjs` gains `frameAncestors` (and `corpFor`): a framed game
  serves `frame-ancestors <shell>` and `Cross-Origin-Resource-Policy:
  cross-origin`; `CONSTRUCT_FRAME_ANCESTORS` sets it for preview.
- `tests/e2e/shell.spec.ts`: the bundle framed by a shell fixture is
  cross-origin isolated and its sign-in click produces a `crowdyjs:navigate`
  to `/authorize` with the shell page as `redirect_uri`.
## 0.7.0 — 2026-09-13

CrowdyJS `17.1.0-dev.1` and crowdy-dsh `0.3.1-dev.1`: on the binary relay
(which this starter turns on) the SDK now packs the messages sent within
`realtime.bundleWindowMs` (1 ms) into one `MESSAGE_BUNDLE` datagram, accepted
by replication server v0.27.0+. Nothing to change here: a lone message is sent
unwrapped, `...AndWait` and `disconnect()` flush on their own, and a hidden tab
flushes each send immediately. `realtime: { bundleSends: false }` opts out.

## 0.6.1 — 2026-09-13

CrowdyJS `17.0.1-dev.1`: a bound Studio save with a stale revision is a
conflict, not a commit.

## 0.6.0 — 2026-09-13

CrowdyJS `17.0.0-dev.1` and crowdy-dsh `0.3.0-dev.1` (ck-api v2.0.0): a bound
GitHub repository is the working tree, and GitHub stays optional.

- A project starts in Crowdy Studio and stays there until its owner binds a
  repository in hosted Studio (push the project in, or take the repository);
  every save and every agent edit then commits to it, "Refresh from GitHub"
  picks up pushes made elsewhere, unbind keeps the files. No behaviour changes
  for a project that never binds.
- The GitHub card keeps riding the game's app token: the API scopes every
  working-tree field to projects this token's user owns, so no identity
  session is needed on this origin and none is held. Connect / Bind / Unbind
  are identity-only and happen in hosted Studio.
- `docs/MODDING.md` says so; `StudioService` says why.

## 0.5.0 — 2026-09-10

Agentic Crowdy Studio in the starter, plus a Studio wallet link.

- `ConstructPlayerHostAdapter` implements `crowdy.player-host/1`: observe,
  walk, look, stop, and proximity chat. Holodeck samples the same axes as WASD.
- `StudioService` mounts the Ask/Build/Play dock when policy and
  `use_studio_agent` are armed, with the Play safety banner outside the dock.
- Setup grants `use_studio_agent` on the *Constructor* tier (never the default
  visitor tier) and writes only the *app* Studio Agent policy
  (`setCrowdyStudioAgentPolicy`). It never reads or writes operator `cp*`
  fields. If the platform catalog is unpublished the step stays green and the
  dock stays closed. Agent tokens stay platform-funded; this game never holds
  an OpenRouter key.
- Default `npm run dev` keeps production COOP/COEP and has no API proxy.
  Local ck-api / IDE-on-public-IP stacks opt in via `VITE_DEV_PROXY`,
  `VITE_DEV_ALLOWED_HOSTS`, and `VITE_DEV_RELAX_ISOLATION` in `.env.local`.
- Live e2e uses hosted Studio login / consent. Node token-seed is opt-in
  (`CONSTRUCT_E2E_SEED_TOKEN=1` plus an explicit `CROWDY_HTTP_URL`).
- HUD **Wallet** opens Studio `/account/wallet` for grid / player-compute
  billing. First-join chat says the same. Studio origin and the hosted
  sign-in URL are derived from `VITE_AUTHORIZE_URL` / `VITE_STUDIO_URL`,
  rewriting loopback when the page is on a public IP so the IDE browser
  does not navigate to `127.0.0.1` and sit on a blank tab.

## 0.4.0 — 2026-09-10

Controls, mouse look/camera, and proximity voice.

- Single `Controls` map: E activates pads (Enter no longer does), T/Enter
  focus chat, V toggles voice, F1/`?` opens the help overlay, Escape unlocks
  look.
- Holodeck mouse look actually works (pointer lock on the canvas, not only
  `#game-root`) plus RMB-drag look for insecure HTTP and wheel zoom.
- Paint: wheel zoom, middle-drag / Alt+LMB pan.
- `VoiceService`: µ-law 8 kHz proximity voice; `microphone=(self)`.
- Game client sets `realtime.binaryTransport: true`.

## 0.3.0 — 2026-09-08

Hosted sign-in (ck-api `v1.88.0`, CrowdyJS `15.6.0`). The browser never holds
an identity session any more, and cannot: the direct sign-in mutations are
served only to Crowded Kingdoms' own pages, so a game on its own domain gets
`HOSTED_SIGN_IN_REQUIRED` from them.

- `NetworkManager`: one `platform` client holding an app-scoped token obtained
  through `portal.signIn` → Studio `/authorize` → `portal.handleSignInCallback`;
  the route (datacenter endpoint) is remembered across reloads; rotation
  mirrors the fresh token; after two failed rotations the player is bounced
  through hosted sign-in again. `enterApp(route)` replaces `enterApp(appId)`.
- `AuthService` is `signIn(appId)` / `completeIfReturning()` / `restore()` /
  `signOut()`. The login form, magic link and guest account are gone;
  `ui/LoginForm.ts` is one button.
- The in-browser Setup wizard is gone (it needed a session). `npm run setup`
  is the door, and it now registers `http://localhost:5175` and every
  `--origin` as a redirect URI (`ensureRedirectUris`), because that list is
  both where sign-in returns the player and the app's CORS allow-list. A
  checkout with no app id shows `ui/NoAppCard.ts` instead.
- HUD: "Setup" is "Switch app" (a fresh hosted sign-in for another id).
- Docs: README (ten minutes), PLATFORM-MAP, ARCHITECTURE, HOSTING, AGENTS,
  `.env.example`.

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
