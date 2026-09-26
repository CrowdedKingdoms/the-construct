# Game concept → platform surface

Where each thing a game needs lives on Crowded Kingdoms, how this repo uses it,
and where to read more. The canonical reference is
[docs.crowdedkingdoms.com](https://docs.crowdedkingdoms.com); the CrowdyJS README
and its `AGENTS.md` carry the concept→API table this one extends.

| Game concept | Platform surface | In this repo |
| --- | --- | --- |
| Accounts, sign-in | **Hosted**: `portal.signIn` → Studio `/authorize` → `portal.handleSignInCallback` — an app-scoped token, never a session. Pass `VITE_AUTHORIZE_URL` when the API origin is not a CK tier host. | `platform/auth/AuthService.ts`, `platform/network/NetworkManager.ts`, `ui/LoginForm.ts` |
| Entering a game | `portal.mintAppToken(appId)` → app-scoped token + the app's endpoint | `platform/network/NetworkManager.ts#enterApp` |
| Org / app creation, tiers | `organizations.create`, `apps.create`, `appAccess.createTier` / `grant` | `platform/onboarding/steps.mjs` |
| Version floor, UDP status | `serverStatus.gameClientBootstrap(appId)` | `NetworkManager#bootstrap` |
| Presence & movement | World Stores `self` / `actors` over `udp.subscribe`; chunk-addressed fan-out | `platform/realtime/WorldStores.ts`, `engine/GameLoop.ts` |
| Terrain / shared canvas / mod-placed blocks | World Stores `chunks` (cache + realtime merge), `markDirty` → `chunks.update` for durability. CLIENT `voxel_set` uses this path. The holodeck draws cubes; Paint draws the y=0 layer in 2D. | `scenes/holodeck-three/voxels.ts`, `scenes/program-pixi/PaintScene.ts`, `platform/studio/clientModHost.ts` |
| Replicated 3D instances (quats, procedural meshes) | Legacy SERVER `emit_spatial("server_event")` eventTypes `0xC501`/`0xC502`; World Stores `events` + `InstanceStore`. `overlay_draw` is local gizmos on the same schema. A ck-exec mod cannot emit, so the Studio's SERVER target no longer feeds it. | `platform/studio/instanceSchema.ts`, `platform/studio/instanceStore.ts`, `scenes/holodeck-three/instanceLayer.ts` |
| Save game | World Stores `save` (per-user `state.*` blob) | `GameSession#loadSave` / `rememberPosition` |
| Chat | `udp.sendTextPacket` + `text` notifications (proximity); `channels.*` for named rooms | `platform/social/ChatService.ts` |
| Server-side rules | ck-exec hubs in Rust (`ckx-sdk`), built with `execBuild`, deployed with `execDeploy`; players call them over `client.exec.connect` | `exec/` (the `world` hub), `scripts/deploy-exec.mjs`, `platform/exec/worldHub.ts`, `platform/model/ModelService.ts` |
| Scheduled world life | Hub timers (`ctx.timer_every`); they run only while players are in the app | The world hub's minute `pulse` timer (`exec/construct`) |
| Player-owned land | `marketplace.claimGridChunk` under `SELF_CLAIM`; grids carry effective permission keys | `platform/studio/GridService.ts` |
| Who is on which grid | Admin-only `gameApps.nearbyPermissions`; players read the game's own claim registry in its world hub | `GridService#lookup`, the world hub's `claims` / `record_claim` / `release_claim` |
| In-game IDE | `@crowdedkingdoms/crowdyjs/crowdy-studio` embed kit over `crowdyStudio`, `exec` (the SERVER target as a mod, `serverEngine: 'ck-exec'`) and `playerCompute` (the CLIENT target) | `platform/studio/StudioService.ts` |
| Players' server code | ck-exec mods: `modBuild` → `modDeploy` → `modSetEnabled`, a hub `mod:<name>` per grid; node API confined to the grid, no emits | `exec/mods/` (the SERVER starters), [MODDING.md](MODDING.md) |
| Crowdy Agent | `client.crowdyStudioAgent` + `context.playerHost`; Constructor `use_studio_agent`; **app** policy (`setCrowdyStudioAgentPolicy`) | `platform/studio/StudioService.ts`, `ConstructPlayerHostAdapter.ts`. Setup writes the app row only — never `cp*` / platform catalog. Model usage is metered to the player wallet by default (or the app's org wallet); no provider key in the game. |
| Player wallet | Studio `/account/wallet` (grid / player-compute billing, not agent tokens) | HUD **Wallet**; origin from `VITE_AUTHORIZE_URL` / `VITE_STUDIO_URL` |
| CLIENT mods for visitors | `marketplace.gridClientMods` → `trustGridAuthor` → `clientArtifactBytes` → `PlayerCodeBroker`. A project whose SERVER target is a mod is not attached (no pairing). | `platform/studio/clientModHost.ts` |
| CLIENT mouse clicks | Host call `pointer_clicks` (broker `input` family); Construct drains holodeck canvas down/up each tick | `platform/studio/pointerClicks.ts`, `clientModHost.ts` |
| Starter mod files | `crowdyStudioCommonPublish` (common-file catalog) | `mods/templates/`, `exec/mods/`, `steps.mjs#publishStarterFiles` |
| Progression | A hub's own state (the world hub's `progress`, created on first read); `ckx_sdk::model` for typed containers | `ModelService#progress` |
| Leaderboards | A hub's own state | not wired |
| Webcam | `udp.sendVideoFrame` (fragments a JPEG into `sendVideoPacket`s) / `video` notifications + `VideoFrameAssembler`; `use_video_chat` | `platform/media/WebcamService.ts`; holodeck draws the face plane (`avatars.ts#setFace`), Paint shows a camera-on ring — a 2D game decides whether to draw video |
| Player left | `actorLeft` notification (Buddy says an actor is gone, ~5 s after its last update) | `WorldStores` lane drops the actor; `WebcamService` ends the stream; scenes free per-uuid objects at once instead of after the 12 s reaper |
| Voice | `udp.sendAudioPacket` / `audio` notifications | `platform/media/VoiceService.ts` (µ-law 8 kHz, V to toggle); holodeck/Paint play nearby speakers |
| Teams, guilds | `teams.*`, `guildBlueprint` → `kit.social` | not wired |
| Cross-game lobby | The same hosted PKCE flow, for another app id | `main.ts` `switchApp` |

## One token in the browser, two on the shell

The browser holds only a short-lived **app-scoped token** for THIS app, obtained
through hosted sign-in: `portal.signIn({ appId, redirectUri })` sends the
player to Crowded Kingdoms' page (Studio `/authorize`) with a PKCE challenge,
and `portal.handleSignInCallback()` exchanges the returned code. The token
response names the endpoint of the datacenter that holds the app's data; the
game client is built there. There is no identity session in the browser and
cannot be: since ck-api v1.88.0 the direct sign-in mutations are served only to
first-party origins (`HOSTED_SIGN_IN_REQUIRED` otherwise), so a game on its own
domain never sees a password. The token rotates in place
(`refreshGameplayToken`); after repeated failure the player is bounced through
hosted sign-in again, which is silent while their Studio session lasts.

The shell scripts (`npm run setup`, `seed`, `deploy:exec`, `smoke`) run in
Node, send no `Origin` header, and therefore CAN sign in directly with
`auth.login` to hold an **identity session** -- which is what creating an org
and app, deploying the world hub and registering redirect URIs need. That is
why Setup lives there and not in the browser. ck-exec builds and deploys go to
the app's own datacenter (the `gameApiUrl` a mint returns) with that session,
because each datacenter's API deploys to its own execution manager.

The app's **redirect URIs** (Studio > Apps > Settings, or `npm run setup
--origin`) are where hosted sign-in may return the player AND the API's CORS
allow-list for the app, origin-matched. A game on an unregistered origin gets
no CORS headers and a refused return leg; one fix.

## The presence rule

Nothing runs for an app with no player in it: a hub's pending timer keeps it
running only while someone is in the app (connected to an execution host, or
in the world), and once nobody has been for a type's eviction window (five
minutes by default) its hubs persist and stop. A repeating timer that came due
while its hub was stopped fires once when the hub starts again; the world hub
re-arms its pulse on every start instead, so it never makes one up. Write
scheduled logic to be correct whenever it next runs rather than assuming a
cadence; `ctx.now_ms()` is the wall clock.

## Where permissions come from

Runtime permission keys live on **access tiers**; players hold a tier per app.
A claim materialises the player's code keys onto the new grid and returns them
as `effectivePermissionKeys`. The game derives the SERVER and CLIENT gates
from those exact keys and nothing else. Visitors fetch and run a grid's
CLIENT artifacts only if *their* tier grants `run_client_code`, which is why
Setup adds the two `run_*` keys to the default tier.

## Reading more

- Client workflow: <https://docs.crowdedkingdoms.com/overview/client-workflow>
- Before you ship: <https://docs.crowdedkingdoms.com/overview/before-you-ship>
- World Stores: <https://docs.crowdedkingdoms.com/crowdyjs/stores>
- ck-exec (dev-tier preview): <https://docs.crowdedkingdoms.com/exec/intro>,
  [timers and presence](https://docs.crowdedkingdoms.com/exec/timers-and-presence),
  [connect from a game](https://docs.crowdedkingdoms.com/exec/connect-from-a-game),
  [builds](https://docs.crowdedkingdoms.com/exec/builds),
  [mods](https://docs.crowdedkingdoms.com/exec/mods),
  [operations](https://docs.crowdedkingdoms.com/exec/operations)
- Grids and permissions: <https://docs.crowdedkingdoms.com/game-api/grids-and-permissions>
- Player code: <https://docs.crowdedkingdoms.com/game-api/player-code>
- Embed Crowdy Studio: <https://docs.crowdedkingdoms.com/crowdyjs/crowdy-studio-embed>
- Datacenter routing: <https://docs.crowdedkingdoms.com/game-api/datacenter-routing>
