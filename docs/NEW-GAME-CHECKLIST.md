# Turning The Construct into your game

A checklist, in the order that keeps everything working at every step.

## 1. Make it yours

- [ ] Rename: `package.json` `name`/`description`, `GAME_NAME` in
      `packages/construct/src/platform/config.ts`, `index.html` title, `public/favicon.svg`.
- [ ] Storage prefixes in `packages/construct/src/platform/envScope.ts` and `WorldStores.ts`
      (`construct:*`) — change them if two of your games could share an origin.
- [ ] `LICENSE` and `README.md`.

## 2. Decide the world

- [ ] World units and chunk size (`CHUNK_SIZE`, 16 by default) and how your
      scenes map to them. Keep every scene in the same world so presence and
      chat make sense across them.
- [ ] Replication radius (`REPLICATION_DISTANCE`) and send cadence
      (`ACTOR_SYNC_INTERVAL_MS`).
- [ ] The pose struct (`packages/construct/src/platform/realtime/actorCodec.ts`). Add what your
      renderer needs (animation state, held item); keep it under ~1 KB. Change
      it in one place and every client must update together.

## 3. Replace the scenes

- [ ] Implement `GameScene` for your first scene ([RENDERER-ADAPTER.md](RENDERER-ADAPTER.md)).
- [ ] Register it in `src/main.ts`; decide whether the holodeck stays as a hub.
- [ ] Put your programs in `PROGRAM_CATALOG` (`model/catalog.mjs`) and their
      pads in `src/game/programs.ts`, then `npm run build:exec-sources`.
- [ ] Remove the demo scene folders and unused renderer dependencies.

## 4. Write your rules

- [ ] Your server code is `exec/`: the world hub (`exec/construct`, Rust on
      `ckx-sdk`) and the manifest (`exec/ckx.json`). Add endpoints there, or
      hubs of your own under the root (starter crates: `client.exec.starters`,
      [builds](https://docs.crowdedkingdoms.com/exec/builds)). Keep per-player
      polling off the root hub (50 calls a second); refuse keys a hub should
      not have.
- [ ] Authorize in handlers with `call.player()` / `call.developer()`: the
      platform names the caller, the client never does.
- [ ] `cargo test && cargo clippy --all-targets` in `exec/` (with a ck-exec
      checkout beside this repo), then `npm run deploy:exec -- --restart` and
      `npm run smoke`.
- [ ] If your hub has another name, tell the framework once at boot:
      `configureWorldHub({ nodeType, key })`.

## 5. Decide who may do what

- [ ] Default tier keys (`VISITOR_RUN_KEYS` in `steps.mjs`): should visitors run
      mods? Paint voxels (`update_voxel_data`)?
- [ ] Constructor tier keys: who gets to write code.
- [ ] Grid claim policy: `SELF_CLAIM` (anyone claims free chunks), `APPROVAL`,
      `INVITE`, or `MARKETPLACE_ONLY`.
- [ ] Which host calls your CLIENT mods may make (`clientModHost.ts`).

## 6. Studio and mods

- [ ] Replace `mods/templates/` (CLIENT starters) and `exec/mods/` (SERVER
      starters, ck-exec mods) with starters that make sense in your world;
      `npm run build:exec-sources`, then `npm run seed`.
- [ ] Decide on `VITE_CONSTRUCT_CLIENT_MODS` (browser execution on or off).
- [ ] Read [MODDING.md](MODDING.md)'s security posture and keep the CSP tight.

## 7. Ship

- [ ] `.env.local` with `VITE_APP_ID` for a single-app deployment.
- [ ] Host with the headers ([HOSTING.md](HOSTING.md)); check
      `crossOriginIsolated` on the live URL.
- [ ] Keep the CrowdyJS pin exact and on `latest` for production
      (`npm run check:pin`). Read the SDK's `MIGRATION.md` before a major bump.
      A pin bump that brings a new realtime feature (15.5 brought webcam
      video and the actor-left notice) lands here as platform code plus a
      `NetworkManager.on(kind)` slot — mirror it in your scenes or hide it.
- [ ] Watch the presence rule in your hubs' timers: nothing ticks while nobody
      plays.
- [ ] ck-exec is a dev-tier preview: a branch that deploys `exec/` cannot be
      promoted to a tier ck-exec has not reached.

## 8. Things this starter leaves to you

- Teams/guilds, channels, the Overworld PKCE lobby, marketplace listings,
  native clients. Each has a platform surface; see
  [PLATFORM-MAP.md](PLATFORM-MAP.md). Webcam (`WebcamService`), voice
  (`VoiceService`), and the Studio agent dock (`ConstructPlayerHostAdapter`)
  are wired. A fork that is not a holodeck must replace the Play adapter
  (inventory, combat, and teleport are not advertised here).
