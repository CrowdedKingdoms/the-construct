# Changelog

## Unreleased

`@crowdedkingdoms/construct` 0.3.8 and CrowdyJS `18.4.0-test.1`. A client mod
on a claimed grid now draws its own scene and gameplay (#89, #90). It uploads
a scene catalog and places instances of it, holds the player's pose, reads
walk, look and key input, tints avatars inside its grid and emits one-shot
events the holodeck draws. The page-owned Afterburn hull, flight and
click-to-shoot path is gone, because that look now comes from the mod.
CrowdyJS 18.3.0 hands those page-held host calls to the game
(`createGridHostCalls`' `local.page`), and 18.4.0 adds the terms and age
gate's consent calls. `GridService` asks the admin-only grid permissions read
once per session that is refused it, instead of on every lookup (#119). The
peer ranges gain the 18.3.0 and 18.4.0 prerelease lines.

`@crowdedkingdoms/construct` 0.3.7, CrowdyJS `18.2.0-dev.1` and crowdy-dsh
`0.4.5-dev.1`. 0.3.6's hydration was not enough on its own: CrowdyJS's chunk
store put a chunk's stored grid back over the edits it had hydrated whenever a
later bulk load returned that chunk again, which happens as soon as the player
moves (the holodeck's cube and Paint's overlap), and never hydrated it again.
CrowdyJS 18.2.0 keeps a chunk it has already loaded. The peer ranges gain the
18.2.0 and 0.4.5 prerelease lines.

`@crowdedkingdoms/construct` 0.3.6: blocks a SERVER mod placed come back after
a reload. Since ck-api v2.33.0 every voxel edit that is not a chunk write-back
(a mod's or hub's `world.set_voxels`, `updateVoxel`, a realtime voxel update)
reaches a reload only as a `getChunk` `voxelStates` entry, and the bulk load's
`voxels` hold none of them. The chunk store hydrated loaded chunks only with a
voxel-state codec, which The Construct has none of, so the pool cue's table and
the spinning child's blocks were live only. The World Stores chunk settings
(`platform/realtime/chunkStoreConfig.ts`) now set `hydrateVoxelStates: true`:
one `chunks.get` per stored chunk the store loads, eight at a time. No SDK
change; still CrowdyJS `18.1.0-dev.1`.

`@crowdedkingdoms/construct` 0.3.5, CrowdyJS `18.1.0-dev.1` and crowdy-dsh
`0.4.4-dev.1`, with no code change. The peer ranges gain the 18.1.0 and 0.4.4
prerelease lines, which npm would not match against the 18.0.4 and 0.4.3
comparators. CrowdyJS 18.1.0 adds `gameApps.setOpenPermissions` /
`openPermissions`, dials an exec gateway only on the game API's domain or the
release's default origin, and reports a refused connect token as `Denied`.

`@crowdedkingdoms/construct` 0.3.4, CrowdyJS `18.0.4-dev.1`. Peers on CrowdyJS
`>=18.0.4-dev.0 <19` (it needs `ChunkStore.onWriteBackFailed`).

- A voxel the server will not save is undone. CrowdyJS 18.0.4's chunk store
  sends a refused write-back (FORBIDDEN: someone else's claim, a safe zone, a
  closed wilderness) once instead of forever, retries anything else five times,
  and reports the drop without undoing it. `GameSession.guardWriteBacks`
  (`platform/realtime/writeBackGuard.ts`, exported, wired in `main.ts`) puts the
  chunk back to the server's copy (or empty when the server never stored it)
  and toasts "You can't build here…", once per stroke. It covers Paint, the
  holodeck and CLIENT `voxel_set`.
- Paint's `flush()` on leaving the scene finishes now; before, it never did once
  a write was refused.

`@crowdedkingdoms/construct` 0.3.3, CrowdyJS `18.0.3-dev.1` (the P3 W5 client
security review). Peers on CrowdyJS `>=18.0.3-dev.0 <19` (it calls the SDK's
revoke calls) and admits crowdy-dsh 0.4.3.

- A CLIENT half could write voxels outside its grid: `parseVoxelSetArgs` read
  `args.chunk` (or `chunk_x`…) before the `chunkX/Y/Z` the broker checks, and the
  write sink never checked the grid. The flat fields win now, and
  `routeClientHostCall` refuses a `voxel_set` outside the grid (and without one).
- "Stop" and "Forget author" beside each CLIENT half running for the player
  (`ui/Hud.ts`): `GridClientHalves.revoke` / `forgetAuthor`,
  `StudioService.stopClientHalf` / `forgetClientHalfAuthor`, and the running
  halves in `StudioState.clientHalves`. A revoke the platform refuses stays
  stopped here and says so.
- The consent question says in plain words what the calls that act as the
  player can do (`describeClientCapabilities`).

`@crowdedkingdoms/construct` 0.3.2: a CLIENT half's `grid_permission_check`
gets a real answer. The Studio preview and `GridClientHalves` passed the grid's
permission keys to CrowdyJS's `createGridHostCalls` but not the player's user id,
so the SDK refused every check. The wiring is `gridServerCalls` now (exported),
with the signed-in player's id. Peers as 0.3.1.

`@crowdedkingdoms/construct` 0.3.1 and CrowdyJS `18.0.1-dev.1`, which only drops
the SDK's super-admin and operator wrappers (nothing here used them). The peer
range gains the 18.0.1 prerelease line, which npm would not match against the
18.0.0 comparator.

`@crowdedkingdoms/construct` **0.3.0** (breaking) and CrowdyJS `18.0.0-dev`: the
legacy engines are gone from the platform on dev (ck-api v2.27.0) and from the
SDK. The construct peers on CrowdyJS 18 only (`>=18.0.0-dev.0 <19`); the 0.2
line stays on 17. crowdy-dsh `0.4.2-dev.1` (the CrowdyJS 18 slice; its peer range
gains the 0.4.2 line).

- Removed: `runConsentedGridMod` and the legacy artifact cache in
  `clientModHost.ts`, `ClientModLifecycle`, and the onboarding step
  `deployModel` with `runOnboarding`'s `blueprints` (no Game Model). A mod's
  CLIENT half is the only browser code a grid serves; `GridClientHalves` runs
  it.
- Crowdy Studio is ck-exec only: `StudioService` passes neither
  `serverEngine` nor a `playerCompute` service.
- `GridClientHalves` forwards a CLIENT half's `crowdy::log` lines (`onLog`,
  the network log by default) and calls its `handle_invoke` (`invoke`).
- `createGridHostCalls` answers `grid_permission_check` from the keys the game
  holds for the grid the player stands on.
- A JS grid program's `grid_context` lists no grid sessions (they were the
  game model's).
- `ensureConstructorTier` decides whether to grant by the target user's access,
  not the caller's: an org admin who held Constructor used to skip granting it
  to another user.

`@crowdedkingdoms/construct` 0.2.3 and CrowdyJS `17.14.0-dev.1`: a mod's
CLIENT half on ck-exec, a dev-tier preview. A CLIENT half needs ck-api v2.24.0
or later, and a Studio CLIENT project v2.25.1 (earlier, Studio refused to save
any `crowdy-client-sdk` crate).

- Crowdy Studio's CLIENT target runs on ck-exec. A CLIENT or full-stack
  project's `crowdy-client-sdk` crate builds on the platform (`modClientBuild`)
  and is attached to the project's mod as its CLIENT half; a CLIENT-only
  project rides the mod named for its CLIENT module, which the Studio deploys
  from the mod starter when the grid has none. `StudioService` no longer
  touches legacy player compute: CrowdyJS 17's embed still types that service,
  and it gets one that refuses.
- Whoever stands on a grid runs its CLIENT halves. `GridClientHalves`
  (`platform/studio/clientHalves.ts`, over CrowdyJS's `ExecClientHalves`)
  lists them, asks once per author (or once per half with
  `hooks.clientHalfConsent: 'mod'`), fetches each by digest and runs it in the
  broker (`engine: 'ck-exec'`, bounded by the consented capability summary)
  through this game's host-call router into the HUD and the overlay, and stops
  them when the player leaves the grid. The owner's own, self-written halves
  run without a question; one installed from a listing asks. While the Studio
  is open on a project, that project's half runs only as the Studio's preview.
- The starter asks in the HUD (`Hud.ask`: "Run it" / "Not now") instead of a
  native `confirm`, which froze the frame loop. `StudioHooks.confirmTrust`
  receives the prompt and an `AbortSignal` that fires when the player leaves
  the grid.
- The HUD greeter and Voxel marker starters are `crowdy-client-sdk` crates
  within the platform's CLIENT build rules. Both build (cargo, `instrument`,
  `wasm-opt`, the CLIENT ABI check), and `mods/templates/index.test.ts` holds
  them to the rules.
- The host-call router reads the arguments crowdy-client-sdk sends:
  `voxel_set`'s `voxelX/Y/Z` (it read only `x/y/z`, so the SDK's `voxel_set`
  was refused as malformed) and `actors_list_radius`'s `radiusXz` / `radiusY`,
  clamped as the platform clamps them, 3 across and 1 up (it read `radius` and
  allowed 8 on every axis).
- Legacy grid-attached client mods no longer run in the starter.
  `runConsentedGridMod` and `ClientModLifecycle` stay exported, deprecated, for
  a game that still runs them until CrowdyJS 18 (construct 0.3.0).
- The construct peer range gains the 17.14 prerelease line.

`@crowdedkingdoms/construct` 0.2.2, CrowdyJS `17.13.0-dev.1` and crowdy-dsh
`0.4.1-dev.1`. The construct peer ranges gain the 17.13 and 0.4.1 prerelease
lines; npm refused both root pins against the 17.12 and 0.4.0 comparators,
the optional crowdy-dsh peer included, and a game installing construct 0.2.1
from npm cannot take CrowdyJS 17.13 at all. 17.13 is additive here (ck-exec
endpoint stats, log flows, version manifests, `CrowdyExecError.rateLimited`),
and a new Studio project's SERVER target now starts from the platform's mod
starter, so it builds as a mod without importing a starter first
(docs/MODDING.md).

`@crowdedkingdoms/construct` 0.2.1: JS grid programs start again in built games.
The package declared `"sideEffects": false`, so bundlers dropped
`sandbox/boot`, which is imported only for what it does on load, and a built
`grid-program.html` loaded Vite's preload polyfill and nothing else. It now
lists `./sandbox/boot.ts`, and CI checks that the built page loads the sandbox
(`npm run check:grid-program`).

`@crowdedkingdoms/construct` 0.2.0 goes to npm. It was only ever on a local
registry, so no game built in CI could install it.

- `publish-construct.yml` publishes `packages/construct` from
  `construct/<tier>/vX.Y.Z` tags (`0.2.0-dev.N` on `dev`, `-test.N` on `test`,
  `0.2.0` on `latest`) with npm Trusted Publishing. It follows CrowdyJS's
  rules: the tagged commit must be in the tier's branch, the tag must match
  `package.json`, the next ordinal comes from the registry, and the dist-tag is
  read back after the publish.
- `scripts/ci/check-package-content.mjs` refuses a tarball that names a
  private repository or internal infrastructure (CrowdyJS's denylist, over
  the files `npm pack` would ship). `npm run test:release` runs it with the
  gate's own test, and CI runs both on every PR.
- The first publish failed before uploading anything: npm 12 prints
  `npm pack --json` as an object keyed by package name, not an array. The check
  reads both shapes, and the publish job pins npm 11.

The game's server moves off the Game Model and automations onto ck-exec (a
dev-tier preview), and Crowdy Studio's SERVER target runs as a ck-exec mod.
CrowdyJS `17.12.0-dev.1`; the `@crowdedkingdoms/construct` peer range admits
the 17.12 prerelease line.

- `exec/`: the world hub, a Rust crate on `ckx-sdk` (`exec/construct`) with
  the manifest `exec/ckx.json` (root `construct`, which only answers
  `status`, and the `world` hub, key `main`). It keeps what the
  `construct-world` blueprint kept: `pulses`, now a 60-second hub timer that
  runs only while players are in the app, as the `construct-pulse` automation
  did (and never makes up missed pulses); the program catalog, compiled in
  from `model/catalog.mjs`; the claim registry (`record_claim` for the calling
  player, `claims`, `release_claim` for the owner only, `forget_claim` for
  developers); and each player's progression, created on first read.
- `ModelService` and `GridService` call the hub over one exec connection per
  page (`NetworkManager.worldHub`); their public methods are unchanged. The
  framework's `configureGameModel` is gone; `configureWorldHub` names a
  game's own hub. Claims kept in the old `Claim` containers are not copied: an
  owner's browser records its grids in the hub on its next visit there, and
  until then visitors see those chunks as open world.
- Setup, `npm run seed` and the new `npm run deploy:exec [-- --restart]`
  build `exec/` on the platform and deploy it (`deployExec` in `steps.mjs`,
  on the app's own datacenter with the developer's session). The
  `construct-world` blueprint, the `construct-pulse` automation and the unused
  progression / leaderboards kit layers are no longer seeded. An app set up
  before keeps them, and nothing reads them any more; its `construct-pulse`
  automation keeps running until it is disabled in Studio. `npm run smoke`
  checks the hub.
- `PROGRAM_CATALOG` moves to `model/catalog.mjs`, the one source of the
  holodeck's pads and the hub's catalog; `npm run build:exec-sources`
  regenerates `exec/construct/src/catalog.rs` and the SERVER starter strings,
  and the unit tests fail while they are stale.
- Crowdy Studio builds, deploys and switches the SERVER target as a mod
  (`serverEngine: 'ck-exec'`). The **Presence beacon**, **Spinning child** and
  **Pool cue** starters are `ckx-sdk` mods under `exec/mods/`: the beacon
  counts the players in its grid and answers `present`; the other two build
  from voxels (a mod cannot send the construct.scene.v1 events they used) and
  step once a second while someone is in the chunk. A mod has no CLIENT
  pairing, so visitors are not offered a ck-exec project's CLIENT half;
  `docs/MODDING.md` lists the gaps.

CrowdyJS `17.9.0-dev.1` (adds `client.exec`, ck-exec's client, as a dev-tier
preview). The `@crowdedkingdoms/construct` peer range admits the 17.8 and 17.9
prerelease lines.

The holodeck renders a replicated 3D scene on a claimed grid. construct.scene.v1
is a parented node graph with quaternions and procedural meshes; the holodeck
renders it for every visitor, CLIENT companion or not. `overlay_draw` stays
local gizmos on the same schema. Voxels remain occupancy.
`emit_spatial("server_event")` is Buddy opcode 139 with `[u16 eventType][state]`
framing; only a legacy SERVER module can send it (see above for the starters).

CLIENT mods can place world objects other players see. The broker already
allowlisted `voxel_set`; this game now routes it through World Stores
`chunks.setVoxel` + `markDirty` (the Paint path), and the holodeck draws
non-air voxels as cubes. HUD text is unchanged and still not HTML.

CLIENT mods can poll holodeck mouse clicks with `pointer_clicks` (drained
each tick). Left down/up plus `holdingMs["0"]` is enough for a click-to-charge
shot; Studio chrome is omitted so authors can test while the IDE is open.

The holodeck draws an amber wireframe (and a faint floor tint) around every
grid this player owns so the claimed 16 m cube is visible against the teal
floor grid.

## 0.8.2 — 2026-09-14

CrowdyJS `17.3.0-dev.1`: the Studio GitHub card gains "Create repository on
GitHub" (GitHub's form prefilled; the App cannot create one itself) and the
`repositorySelection` reminder.

## 0.8.1 — 2026-09-14

Holodeck A/D was inverted. The ground-right vector was
`(forward.z, −forward.x)`, which is left when the follow camera sits on +Z.
`moveBasis` / `wishOnGround` in `src/scenes/shared/cameraLook.ts` now use the
right-handed perpendicular so D is screen-right and A is screen-left; unit
tests lock the signs.

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
