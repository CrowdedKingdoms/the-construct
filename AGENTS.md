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

`dev`, `test`, `prod`; work lands on `dev` via pull request; promotion is a
merge forward. The CrowdyJS pin is **exact** and **per tier**:
`dev` → `X.Y.Z-dev.N`, `test` → `X.Y.Z-test.N`, `prod` → `X.Y.Z`. Each published
build carries its tier's API origin, so a wrong pin dials the wrong
environment. `scripts/ci/check-sdk-pin.mjs` refuses a caret and a cross-tier
pin; CI runs it against the PR base. **After any promotion merge, re-check the
pin** — git resolves `package.json`/`package-lock.json` silently in whichever
direction changed last. Repin with `npm install --save-exact
@crowdedkingdoms/crowdyjs@<version>`.

There is no deploy workflow, deliberately: hosting is the developer's.

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
- `model/blueprints.mjs`, `mods/templates/index.mjs` and
  `src/platform/onboarding/steps.mjs` are plain ES modules on purpose: the Node
  scripts import them and the browser imports the first two. Keep them free of
  TypeScript and of browser-only globals; their `.d.mts` siblings carry types.
- Seeding is idempotent on the server since ck-api `v1.93.0`: `gameModelSeed`
  upserts containers by `binding_key = seed:<tempId>` and skips existing
  edges. `deployModel`'s client-side "already exists" filter is redundant,
  not wrong — keep it.

## Platform facts this code depends on (measured 2026-09-07, dev tier)

- `nearbyGridPermissions` still requires `manage_apps`. Players can call
  `nearbyGrids` (ck-api `v1.93.0`: `gridId` + bounds, no `permissionKeys`).
  This game still uses `Claim` containers; that workaround was not rewritten.
- Model expressions have `now()` (int milliseconds, one instant per invoke).
- A CLIENT mod runs for visitors only as the required companion of a live
  SERVER module (full-stack project), after the visitor trusts the author, and
  only if the **visitor's** tier holds `run_client_code`.
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
- The Studio's blank project declares only `crowdy-compute-sdk`; templates
  that build JSON ship a companion `Cargo.toml` with `serde_json`.

## Docs

`README.md` is the front door; `docs/` holds ARCHITECTURE, RENDERER-ADAPTER,
PLATFORM-MAP, MODDING, NEW-GAME-CHECKLIST, HOSTING. When code and a doc
disagree, fix the doc in the same change. `CHANGELOG.md` is human-written.
