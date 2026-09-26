# Architecture

The Construct is a presentation-and-intent client. It renders, takes input,
interpolates other players, and asks the platform to do things. It does not
own anything a player could cheat by editing: inventories, scores, who owns a
grid, and who may run code are decided by the Crowded Kingdoms platform and
the game's own server code, the world hub it deploys to ck-exec.

## Layers

| Layer | Owns | Never does |
| --- | --- | --- |
| **Scenes** (`src/scenes/*`) | Rendering, camera, input handling, the local player's position, pads and pickups | Talk to the network, hold a token, decide permissions |
| **Engine** (`packages/construct/src/engine/`) | The frame loop, the scene router, keyboard/pointer state, feeding the local pose to replication | Know which renderer a scene uses |
| **Platform** (`packages/construct/src/platform/`) | Hosted sign-in, app entry, tokens, presence, chunks, save, chat, webcam (`media/WebcamService`: capture → `sendVideoFrame`; `video` notifications → per-uuid bitmaps; ended on `actorLeft`), world hub calls, Studio, onboarding | Render (a bitmap is handed to the scene, which owns drawing and disposal) |
| **World hub** (`exec/`) | The game's server code on ck-exec: the pulse, the program catalog, the claim registry, progression | Trust a client's word for who is calling |
| **CrowdyJS** | GraphQL + realtime transport, World Stores, `client.exec` (ck-exec connections, builds, deploys, mods), Crowdy Studio chrome, the mod sandbox broker | — |
| **Crowded Kingdoms** | Authorization, grids and claims, ck-exec (running the world hub and players' mods), compile + admission of player code, presence, persistence | — |

## The boot sequence

`src/main.ts`, top to bottom:

1. `ensureEnvScope()` — every browser-storage key this game writes is
   namespaced by the API origin, so two tiers in one browser never share a
   session or an app id.
2. `completeHostedSignInIfPresent()` — returning from Crowded Kingdoms' sign-in
   page with `?code=`? The SDK exchanges it for an app-scoped token and the
   app's route. Else `restore()` — a stored token is verified with `users.me()`.
3. `resolveAppId()` — `?app=` in the URL, then the id this browser remembered,
   then `VITE_APP_ID`. With none, the **no-app card**: Setup runs from a shell
   (`npm run setup`), because creating an app needs an identity session and a
   game on its own domain never holds one. With an id and no token, the
   **sign-in card**: one button, `portal.signIn`, and the browser leaves for
   Studio's `/authorize`.
4. `network.enterApp(route)` — the token response already named the app's own
   endpoint (`gameApiUrl`). The game client is built on that endpoint with the
   same token; `discoveryUrl` stays on the shared origin so a dead instance can
   be left. `bootstrap()` reads version floors and UDP status.
5. `GameSession` — the facade scenes receive. `loadSave()` hydrates the typed
   save blob; `join(position)` announces presence (World Stores `self.join`)
   and starts chat.
6. `router.load('holodeck', spawn)`; `loop.start()`. The token rotates every 20
   minutes via `refreshGameplayToken()` with a re-mint fallback.

## Replication

World Stores (`@crowdedkingdoms/crowdyjs/stores`) run over one shared
`udpNotifications` subscription:

- `self` — the local actor. The loop calls `session.feedPose(pose)` every
  frame; the store sends at 5 Hz, only when bytes changed, with keyframes.
- `actors` — everyone else, decoded once with the same `poseCodec` and
  reaped when stale. Scenes read `session.players(programId)`.
- `chunks` — the voxel cache the Paint program draws on, the holodeck draws
  as cubes, and CLIENT mods read and write (`voxel_set`). Realtime edits
  merge in; `markDirty` queues durable write-back.
- `host` — 3 s heartbeats that keep the actor's presence fresh for the
  server-side gates (player-compute occupancy, artifact fetches).
- `save` — a JSON blob per user per app, autosaved.

The pose is a fixed 64-byte struct (`packages/construct/src/platform/realtime/actorCodec.ts`):
position, look, velocity, flags, a `program` byte saying which scene the
player is in, an avatar tint, and a 24-byte name. Both renderers consume it;
the holodeck hides players whose `program` is not 0 and Paint shows only its own.

Presence is spatial: everything is addressed to a chunk (16 units) and fanned
out within `REPLICATION_DISTANCE` chunks. Proximity chat rides the same path.

## The world hub

The game's server code is `exec/`: a ck-exec manifest (`ckx.json`) and one Rust
crate, `exec/construct`, built on the platform (`execBuild`) and deployed with
the app (`execDeploy`) by `npm run setup`, `npm run seed` and `npm run
deploy:exec`. It declares two hubs:

- `construct`, the app's root hub, which only answers `status`. The platform
  limits a root hub to 50 calls a second, so nothing polls it.
- `world`, keyed `main` (it refuses any other key), which holds what the
  legacy Game Model kept in containers:
  - `pulses`, advanced by a 60-second hub timer. Hub timers run only while
    players are in the app, as the `construct-pulse` automation did, and the
    timer is re-armed whenever the hub starts, so missed pulses are never made
    up. Each pulse is published on the `pulse` topic.
  - the program catalog, compiled in from `model/catalog.mjs`
    (`npm run build:exec-sources` writes `exec/construct/src/catalog.rs`);
  - the claim registry: which chunk became which player's grid. `record_claim`
    records for the calling player (the platform names the caller; a client
    cannot name an owner), `claims` lists (by chunk, the caller's own, or all),
    `release_claim` removes only the caller's own, and developers can
    `forget_claim` anyone's;
  - each player's progression (level, xp, skill points), created on first
    read and read-only, as it was.

Endpoints reply with plain maps (camelCase keys); a refusal comes back as an
`AppError` with the hub's reason. The hub is snapshotted every 30 seconds and
at once after a claim or progression change.

The browser reaches it through `NetworkManager.worldHub`: one exec connection
per page (`client.exec.connect(appId, { nodeType: 'world', key: 'main' })`,
the app token as the session), opened by the first call and closed with the
game client; after a failed connect, calls fail fast for 15 seconds instead of
dialling again. `ModelService` (`world`, `programs`, `progress`) and
`GridService` (the claim registry) call it and cache reads for 15 and 10
seconds, because the HUD and the Studio poll. A game built on the framework
names its own hub with `configureWorldHub({ nodeType, key })`.

A running hub keeps the version it started with until it stops, and the world
hub, its timer pending, does not stop while players are in the app:
`npm run deploy:exec -- --restart` switches its type off and on so the next
call starts it on the new version from its snapshot.

## Crowdy Studio and player code

See [MODDING.md](MODDING.md). In one paragraph: a player claims a chunk
(`claimGridChunk`, policy `SELF_CLAIM`); the platform returns the grid and the
player's effective code keys; the SDK's embed kit renders the IDE; SERVER
targets build on the platform and run as ck-exec mods, hubs on the grid that
players there call by name (`serverEngine: 'ck-exec'`); CLIENT modules compile
on the platform and run in a same-origin worker in the browser through a
SharedArrayBuffer bridge, with every host call allowlisted by the SDK's broker
and answered by this game's router. Visitors run a grid's attached CLIENT mods
after trusting the author. All of that needs the page to be cross-origin
isolated, which is why `security-headers.mjs` exists.

The Ask/Build/Play agent is the same embed. `StudioService` passes
`client.crowdyStudioAgent` and a `ConstructPlayerHostAdapter` (`observe`,
walk, look, stop, proximity chat). Setup puts `use_studio_agent` on the
Constructor tier and writes the **app** policy. The platform catalog is an
operator concern (this starter never reads or writes `cp*` fields). The Play
safety banner lives outside the dock. Model usage is metered per request to
the player's wallet by default (or the app's org wallet) — this game never
holds a provider key. HUD **Wallet** links to Studio for the same wallet, which
also covers grid / player-compute billing.

## Generic versus demo

Keep (or adapt) for any game: everything under `packages/construct/src/platform/`, `packages/construct/src/engine/`,
`security-headers.mjs`, `scripts/`, `exec/` as a pattern, the Studio
integration, the shell Setup.

Replace with your game: `src/scenes/*` (the holodeck and Paint), `model/catalog.mjs`
and `src/game/programs.ts` (the programs and their pads), the world hub's rules
(`exec/construct`), `mods/templates/` and `exec/mods/` (your starter mods), the
HUD chrome in `src/ui/`.

## Design rules this repo follows

- **No hostnames in the repository.** The installed SDK build carries its
  tier's origin; the pin carries the tier. A fallback URL would make a missing
  prerequisite indistinguishable from a satisfied one.
- **No permission logic client-side.** Permissions come back from claims and
  reads as exact keys; SERVER and CLIENT gates are derived independently and
  never inflated.
- **Idempotent administration.** Every onboarding step reports whether it
  changed anything and can be re-run.
- **Fail visibly.** A missing COOP/COEP header shows a banner and disables the
  CLIENT half instead of letting a worker fail silently. A failed scene mount
  restores the previous scene.
