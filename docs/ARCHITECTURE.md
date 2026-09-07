# Architecture

The Construct is a presentation-and-intent client. It renders, takes input,
interpolates other players, and asks the platform to do things. It does not
own anything a player could cheat by editing: inventories, scores, who owns a
grid, and who may run code are decided by the Crowded Kingdoms platform and
the game model deployed to it.

## Layers

| Layer | Owns | Never does |
| --- | --- | --- |
| **Scenes** (`src/scenes/*`) | Rendering, camera, input handling, the local player's position, pads and pickups | Talk to the network, hold a token, decide permissions |
| **Engine** (`src/engine/`) | The frame loop, the scene router, keyboard/pointer state, feeding the local pose to replication | Know which renderer a scene uses |
| **Platform** (`src/platform/`) | Sign-in, app entry, tokens, presence, chunks, save, chat, model reads, Studio, onboarding | Render |
| **CrowdyJS** | GraphQL + realtime transport, World Stores, Game Kit, Crowdy Studio chrome, the mod sandbox broker | — |
| **Crowded Kingdoms** | Authorization, grids and claims, the game model, compile + admission of player code, presence, persistence | — |

## The boot sequence

`src/main.ts`, top to bottom:

1. `ensureEnvScope()` — every browser-storage key this game writes is
   namespaced by the API origin, so two tiers in one browser never share a
   session or an app id.
2. `completeMagicLinkIfPresent()` then `restoreIdentity()` — a stored session
   is verified with `users.me()`. If there is none, the sign-in form.
3. `resolveAppId()` — `?app=` in the URL, then the id the wizard remembered,
   then `VITE_APP_ID`, else the **Setup wizard** (see below).
4. `network.enterApp(appId)` — `portal.mintAppToken` returns a short-lived
   app-scoped token AND the app's own endpoint (`gameApiUrl`). The game client
   is built on that endpoint; `discoveryUrl` stays on the shared origin so a
   dead instance can be left. `bootstrap()` reads version floors and UDP status.
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
- `chunks` — the voxel cache the Paint program draws on and CLIENT mods read.
  Realtime edits merge in; `markDirty` queues durable write-back.
- `host` — 3 s heartbeats that keep the actor's presence fresh for the
  server-side gates (player-compute occupancy, artifact fetches).
- `save` — a JSON blob per user per app, autosaved.

The pose is a fixed 64-byte struct (`src/platform/realtime/actorCodec.ts`):
position, look, velocity, flags, a `program` byte saying which scene the
player is in, an avatar tint, and a 24-byte name. Both renderers consume it;
the holodeck hides players whose `program` is not 0 and Paint shows only its own.

Presence is spatial: everything is addressed to a chunk (16 units) and fanned
out within `REPLICATION_DISTANCE` chunks. Proximity chat rides the same path.

## The game model

`model/blueprints.mjs` is the single definition, deployed by the wizard and by
`npm run seed` through `client.kit(appId).deploy(...)`:

- `progressionBlueprint` (XP/levels/skills, trusted grants only) and
  `leaderboardsBlueprint` (keep-best scores, host-submitted) — two kit layers
  most games need, as-is.
- A hand-authored layer: `Program` catalog, a `WorldState` singleton with a
  minute-interval automation, and `Claim` — the player-readable registry of
  which chunk became which grid.

Re-seeding is safe: definitions upsert by name, and the seed step skips
containers that already exist (the platform would otherwise create duplicates
on every run). `ModelService` reads the model with a player token.

Two platform facts the model shows honestly: schedule automations run only
while the app has a player (the presence rule), and model expressions have no
clock — elapsed-time logic belongs in a compute module or a validated
client-supplied timestamp.

## Crowdy Studio and player code

See [MODDING.md](MODDING.md). In one paragraph: a player claims a chunk
(`claimGridChunk`, policy `SELF_CLAIM`); the platform returns the grid and the
player's effective code keys; the SDK's embed kit renders the IDE; SERVER
modules compile and run on the platform; CLIENT modules compile on the platform
and run in a same-origin worker in the browser through a SharedArrayBuffer
bridge, with every host call allowlisted by the SDK's broker and answered by
this game's router (`world_read` only). Visitors run a grid's mods after
trusting the author. All of that needs the page to be cross-origin isolated,
which is why `security-headers.mjs` exists.

## Generic versus demo

Keep (or adapt) for any game: everything under `src/platform/`, `src/engine/`,
`security-headers.mjs`, `scripts/`, `model/blueprints.mjs` as a pattern, the
Studio integration, the Setup wizard.

Replace with your game: `src/scenes/*` (the holodeck and Paint), `src/platform/programs.ts`
(the pad list), the hand-authored part of the model, `mods/templates/` (your
starter mods), the HUD chrome in `src/ui/`.

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
