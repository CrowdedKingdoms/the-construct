# AGENTS

The Construct is the **public** starter repository for third-party browser
games on Crowded Kingdoms. It consumes the published `@crowdedkingdoms/crowdyjs`
package and the public API only.

## Boundaries (hard)

- **Nothing private lands here.** No app ids, credentials, internal hostnames,
  operator scripts, CDN/CloudFront configuration, New Relic, or anything from
  the privileged repositories. The API origin comes from the installed SDK
  build; `.env.example` carries no hostname and must not.
- **Only public SDK surfaces.** If a needed operation is not wrapped by the SDK,
  use `client.graphql.query` with a public root field (as
  `publishStarterFiles` does) and say so in a comment. Never call operator
  `cp*` fields from this repo — Setup writes app-scoped admin
  (`setCrowdyStudioAgentPolicy`, Constructor `use_studio_agent`) only.
- **A third party must be able to run it cold**: `git clone`, `npm install`,
  `npm run setup` (their own account), `npm run dev`, sign in through Crowded
  Kingdoms, play. Anything that needs an operator or a CK-owned resource does
  not belong on the default path.
- **The browser never holds an identity session, and cannot.** Since ck-api
  v1.88.0 the direct sign-in mutations (`auth.login` / `register` / magic link /
  social) are served only to first-party origins and to non-browser callers;
  from this game's page they answer `HOSTED_SIGN_IN_REQUIRED`. Players sign in
  through `portal.signIn` → Studio `/authorize` → `portal.handleSignInCallback`
  and the page holds an app-scoped token only. Everything that needs a session
  (org, app, tier, seed, redirect URIs) lives in `scripts/` (Node, no Origin
  header). Do not reintroduce a login form, a guest account or a browser
  wizard; do not call `network.platform.auth.*` from `src/`.

## Branches and the SDK pin

`dev`, `test`, `prod`; work lands on `dev` via pull request (you merge your own
PR on `dev`; `test` and `prod` need an org admin). Promotion is a
merge forward. The CrowdyJS pin is **exact** and **per tier**:
`dev` → `X.Y.Z-dev.N`, `test` → `X.Y.Z-test.N`, `prod` → `X.Y.Z`. Each published
build carries its tier's API origin, so a wrong pin dials the wrong
environment. `scripts/ci/check-sdk-pin.mjs` refuses a caret and a cross-tier
pin; CI runs it against the PR base. **After any promotion merge, re-check the
pin** — git resolves `package.json`/`package-lock.json` silently in whichever
direction changed last. Repin with `npm install --save-exact
@crowdedkingdoms/crowdyjs@<version>`, or promote with
`infra-control-plane/scripts/ops/promote.mjs --repo the-construct --from <tier> --to <tier>`, which re-pins to the destination
tier's registry artifact, runs `check:pin` and opens the PR.
`packages/construct` peers on the SDK with one comparator per minor line
(`>=17.9.0-dev.0 <18`, …): npm admits a prerelease only against a comparator
naming the same `X.Y.Z`, so a repin to a new minor adds its line there first,
or `npm install` refuses the root pin with `ERESOLVE`.

**The framework package is published to npm by its own tags.**
`publish-construct.yml` releases `packages/construct` from
`construct/<tier>/vX.Y.Z` (dev `X.Y.Z-dev.N`, test `X.Y.Z-test.N`, prod `X.Y.Z`
on `latest`), apart from this repo's `<tier>/vX.Y.Z` tags, which version the
starter. Bump `packages/construct/package.json`, the root pin and the lockfile's
`packages/construct` entry together, merge to the tier's branch, then tag that
commit: the gate (`scripts/ci/resolve-construct-release.sh`) refuses a tag whose
commit isn't in the branch, and the job refuses a tag that disagrees with
`package.json`. It publishes with npm Trusted Publishing, which trusts this
workflow by file name, so renaming it needs the package's npm settings changed
too. `npm run test:release` runs the gate's test and the tarball content check.

There is no deploy workflow in this repo, deliberately. Hosting is the
developer's -- and since 0.8.0 one of the developer's options is
`npm run publish` (`scripts/publish.mjs`), which publishes `dist/` to Crowdy
Games through the public hosting surface (`client.hosting`, ck-api v2.1) on the
IDENTITY client, never the app token. A game published there runs framed by the
platform's first-party shell; the SDK's `EmbeddedHost` bridge makes hosted
sign-in work unchanged, and `tests/e2e/shell.spec.ts` proves the framed bundle
is cross-origin isolated and routes sign-in through the shell. `security-headers.mjs`
takes `frameAncestors` for a shell of your own; unframed output is unchanged.
Crowded Kingdom Studios publishes this repo itself as `the-construct` (a slug
reserved for that org) through the same command a third party runs.

## Working in this repo

- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm run build` must pass; `npm run test:e2e` proves the served bundle is
  cross-origin isolated (Playwright, Chromium).
- Live verification needs an account you own on the tier the pin targets:
  `CONSTRUCT_EMAIL`/`CONSTRUCT_PASSWORD` → `npm run setup` → `npm run smoke`,
  then `CONSTRUCT_E2E=1 APP_ID=<id> CONSTRUCT_E2E_URL=http://localhost:5175
  npm run test:e2e` against `npm run dev` (the live test uses the dev-only
  `window.__construct` handle). Hosted Studio login is the path; do not seed
  an app token unless `CONSTRUCT_E2E_SEED_TOKEN=1` and `CROWDY_HTTP_URL` are
  set. A local ck-api or IDE-on-public-IP stack is opt-in via `VITE_DEV_*` in
  `.env.local` (see `.env.example`); default `npm run dev` is isolating and
  unproxied.
- `model/catalog.mjs`, `mods/templates/index.mjs` (with the generated
  `exec-mods.mjs`) and `src/platform/onboarding/steps.mjs` are plain ES modules
  on purpose: the Node scripts import them and the browser imports the catalog.
  Keep them free of TypeScript and of browser-only globals; their `.d.mts`
  siblings carry types.
- The game's server code is `exec/`: a ck-exec manifest (`ckx.json`: the root
  `construct` and the `world` hub) and the Rust crates, `construct` and the
  SERVER starter mods under `mods/`. From `exec/`, `cargo test`,
  `cargo clippy --all-targets` (no warnings) and `cargo build --release
  --target wasm32-unknown-unknown` must pass when you touch it. They need a
  ck-exec checkout beside this repository for `ckx-sdk`, which is not public,
  so CI cannot run them; the platform's build replaces that dependency line.
- `npm run build:exec-sources` after editing `model/catalog.mjs` or
  `exec/mods/`: it rewrites `exec/construct/src/catalog.rs` and
  `mods/templates/exec-mods.mjs`, and the unit tests (and every deploy) fail
  while either is stale.
- What `execBuild` / `execModBuild` accept: files `Cargo.toml`, `README.md` and
  `src/**/*.rs`; `[package]`, `[lib] crate-type = ["cdylib", "rlib"]` and
  `[dependencies]` on `ckx-sdk`, `serde` and `serde_json` only, one key per
  line; edition 2024. The source guard refuses the identifiers `include`,
  `include_str`, `include_bytes`, `env`, `option_env` and the `asm` family
  anywhere in code (not only as macros), and `path` / `link` inside an
  attribute.
- ck-exec builds, deploys and switches take the developer's own session (the
  org's `manage_compute`) on the app's own datacenter origin
  (`scripts/lib/cli.mjs#developerOnApp`), never an app token: another
  datacenter's API deploys to its own execution manager.
  `npm run deploy:exec -- --restart` switches every type off and on so a
  running hub (the world hub never idles while players are in) starts again
  on the new version.
- `deployModel` stays in `steps.mjs` for games that keep a Game Model; the
  starter no longer seeds one.

## Platform facts this code depends on (measured 2026-09-07, dev tier)

- `nearbyGridPermissions` still requires `manage_apps`. Players can call
  `nearbyGrids` (ck-api `v1.93.0`: `gridId` + bounds, no `permissionKeys`).
  This game keeps its own claim registry in the world hub instead: a claim is
  recorded for the calling player and only its owner may release it
  (developers can `forget_claim`). The hub does not ask the platform who owns
  a grid, so a player can still record a grid id they do not own if no one
  recorded it first.
- A self-authored CLIENT mod runs for visitors only as the required companion
  of a live **legacy** SERVER module, after the visitor trusts the author, and
  only if the **visitor's** tier holds `run_client_code`: ck-api creates the
  grid client attachment when that player-compute module is enabled. With the
  SERVER target on ck-exec (`serverEngine: 'ck-exec'`, since this branch) the
  Studio sets no pairing, so a full-stack project's CLIENT half runs for its
  author only.
- The trust/artifact gates check presence written by Buddy on chunk entry;
  asking in the first seconds after entering a grid races it. `GRID_SETTLE_MS`.
- `PlayerCodeBroker` ticks a client mod only when `tickIntervalMs` is set.
- `marketplace.claimGridChunk` on a chunk the caller already owns is refused
  (`GRID_ALREADY_CLAIMED`); it returns the effective keys only on the first
  claim. `GridService` remembers them in localStorage; a fresh browser sees
  the claim through the game's registry without keys (open item).
- `use_video_chat` is opt-in on a tier (never in an app's default keys); the
  default world grid and a self-claimed chunk carry it only when the tier does
  (ck-api ≥ v1.87.3 for the claimed chunk).
- `use_studio_agent` is also opt-in and belongs on the Constructor tier only,
  never the default visitor tier. The dock mounts when app policy and that
  key are live (enforced server-side). The platform catalog is an operator
  concern — this starter never publishes or unkills it. Agent tokens are
  platform-funded; `OPENROUTER_API_KEY` lives only in ck-api, never here.
- The API refuses an empty `voxelState`; `ChunkStore.setVoxel` sends `''`
  without a `state`. Paint sends one byte.
- Realtime voxel updates are live-only; durability is the chunk store's
  write-back (`markDirty` → `chunks.update`).
- pixi.js v8 needs `import 'pixi.js/unsafe-eval'` under a CSP without
  `unsafe-eval`.
- The Studio's blank project declares only `crowdy-compute-sdk` (CrowdyJS
  17.12.0, for both targets); CLIENT templates that build JSON ship a companion
  `Cargo.toml` with `serde_json`. A blank SERVER project does not build as a
  mod: players import a SERVER starter's `Cargo.toml` and `src/lib.rs`.

## ck-exec facts this code depends on (2026-09-26, local cluster and ck-api source)

- ck-exec is a **dev-tier preview**: `setup`, `seed` and `deploy:exec` work
  only against dev. Do not promote this to `test` / `prod` before ck-exec
  reaches those tiers.
- The root hub takes at most 50 calls a second; the HUD's polling goes to
  `world/main`, never the root.
- A pending timer keeps a hub running only while players are in the app, and
  a hub is snapshotted every 30 s by default (at most one interval is lost in
  a crash). The world hub re-arms its pulse timer on every start, so a
  stopped world does not make up missed pulses, and calls `persist_now` after
  a claim or progression change.
- A mod calls no other node, subscribes to nothing, and its realtime emits are
  dropped. Its node API reaches only its grid: `grids.get` for its own id,
  `world.*` inside the grid's bounds, and `world.set_voxels` only while its
  owner holds `update_voxel_data` there. That is why the scene starters build
  with voxels, not construct.scene.v1 events.
- Node API budget, shared by every hub and mod of an app: 200 reads and 50
  voxel writes a second per ck-api replica.
- The execution host's gateway is a `wss://` name under the tier's zone, which
  the CSP's zone wildcard already admits.

## Docs

`README.md` is the front door; `docs/` holds ARCHITECTURE, RENDERER-ADAPTER,
PLATFORM-MAP, MODDING, NEW-GAME-CHECKLIST, HOSTING. When code and a doc
disagree, fix the doc in the same change. `CHANGELOG.md` is human-written.
