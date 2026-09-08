# Turning The Construct into your game

A checklist, in the order that keeps everything working at every step.

## 1. Make it yours

- [ ] Rename: `package.json` `name`/`description`, `GAME_NAME` in
      `src/platform/config.ts`, `index.html` title, `public/favicon.svg`.
- [ ] Storage prefixes in `src/platform/envScope.ts` and `WorldStores.ts`
      (`construct:*`) — change them if two of your games could share an origin.
- [ ] `LICENSE` and `README.md`.

## 2. Decide the world

- [ ] World units and chunk size (`CHUNK_SIZE`, 16 by default) and how your
      scenes map to them. Keep every scene in the same world so presence and
      chat make sense across them.
- [ ] Replication radius (`REPLICATION_DISTANCE`) and send cadence
      (`ACTOR_SYNC_INTERVAL_MS`).
- [ ] The pose struct (`src/platform/realtime/actorCodec.ts`). Add what your
      renderer needs (animation state, held item); keep it under ~1 KB. Change
      it in one place and every client must update together.

## 3. Replace the scenes

- [ ] Implement `GameScene` for your first scene ([RENDERER-ADAPTER.md](RENDERER-ADAPTER.md)).
- [ ] Register it in `src/main.ts`; decide whether the holodeck stays as a hub.
- [ ] Update `src/platform/programs.ts` and `PROGRAM_CATALOG` in
      `model/blueprints.mjs` together.
- [ ] Remove the demo scene folders and unused renderer dependencies.

## 4. Model your rules

- [ ] Pick Game Kit blueprints (inventory, economy, quests, combat, matches…)
      and add them to `constructBlueprints()` with your `typePrefix`es; mirror
      the prefixes in `kitOptions()`.
- [ ] Hand-author what the kit does not cover: container types, properties,
      functions with invoke policies, automations.
- [ ] Keep `deployModel`'s existing-container check in mind: seed containers
      are matched by display name per type.
- [ ] `npm run seed` after every change; `npm run smoke` to verify.

## 5. Decide who may do what

- [ ] Default tier keys (`VISITOR_RUN_KEYS` in `steps.mjs`): should visitors run
      mods? Paint voxels (`update_voxel_data`)?
- [ ] Constructor tier keys: who gets to write code.
- [ ] Grid claim policy: `SELF_CLAIM` (anyone claims free chunks), `APPROVAL`,
      `INVITE`, or `MARKETPLACE_ONLY`.
- [ ] Which host calls your CLIENT mods may make (`clientModHost.ts`).

## 6. Studio and mods

- [ ] Replace `mods/templates/` with starters that make sense in your world.
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
- [ ] Watch the presence rule in your automations: nothing ticks while nobody
      plays.

## 8. Things this starter leaves to you

- Voice chat (`udp.sendAudioPacket`), teams/guilds, channels, the Overworld
  PKCE lobby, marketplace listings, the Studio agent dock, native clients.
  Each has a platform surface; see [PLATFORM-MAP.md](PLATFORM-MAP.md).
  (Webcam video is wired — `WebcamService` — so voice is the one media lane
  left; it is the same shape with `sendAudioPacket`.)
