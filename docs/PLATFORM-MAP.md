# Game concept → platform surface

Where each thing a game needs lives on Crowded Kingdoms, how this repo uses it,
and where to read more. The canonical reference is
[docs.crowdedkingdoms.com](https://docs.crowdedkingdoms.com); the CrowdyJS README
and its `AGENTS.md` carry the concept→API table this one extends.

| Game concept | Platform surface | In this repo |
| --- | --- | --- |
| Accounts, sign-in | `auth.login` / `auth.register`, magic link, social — identity session token | `platform/auth/AuthService.ts`, `ui/LoginForm.ts` |
| Entering a game | `portal.mintAppToken(appId)` → app-scoped token + the app's endpoint | `platform/network/NetworkManager.ts#enterApp` |
| Org / app creation, tiers | `organizations.create`, `apps.create`, `appAccess.createTier` / `grant` | `platform/onboarding/steps.mjs` |
| Version floor, UDP status | `serverStatus.gameClientBootstrap(appId)` | `NetworkManager#bootstrap` |
| Presence & movement | World Stores `self` / `actors` over `udp.subscribe`; chunk-addressed fan-out | `platform/realtime/WorldStores.ts`, `engine/GameLoop.ts` |
| Terrain / shared canvas | World Stores `chunks` (cache + realtime merge), `markDirty` → `chunks.update` for durability | `scenes/program-pixi/PaintScene.ts` |
| Save game | World Stores `save` (per-user `state.*` blob) | `GameSession#loadSave` / `rememberPosition` |
| Chat | `udp.sendTextPacket` + `text` notifications (proximity); `channels.*` for named rooms | `platform/social/ChatService.ts` |
| Server-side rules | Game model containers/properties/functions with invoke policies; Game Kit blueprints | `model/blueprints.mjs`, `platform/model/ModelService.ts` |
| Scheduled world life | Model automations (`schedule` / `event`), compute modules; run only while players are present | `construct-pulse` automation |
| Player-owned land | `marketplace.claimGridChunk` under `SELF_CLAIM`; grids carry effective permission keys | `platform/studio/GridService.ts` |
| Who is on which grid | Admin-only `gameApps.nearbyPermissions`; players read the game's own `Claim` registry | `GridService#lookup` |
| In-game IDE | `@crowdedkingdoms/crowdyjs/crowdy-studio` embed kit over `crowdyStudio` + `playerCompute` | `platform/studio/StudioService.ts` |
| CLIENT mods for visitors | `marketplace.gridClientMods` → `trustGridAuthor` → `clientArtifactBytes` → `PlayerCodeBroker` | `platform/studio/clientModHost.ts` |
| Starter mod files | `crowdyStudioCommonPublish` (common-file catalog) | `mods/templates/`, `steps.mjs#publishStarterFiles` |
| Progression, leaderboards | `kit.progression`, `kit.leaderboards` | `ModelService#progress` |
| Voice | `udp.sendAudioPacket` / `audio` notifications | not wired; see BWF's `VoiceChat` pattern in the docs |
| Teams, guilds | `teams.*`, `guildBlueprint` → `kit.social` | not wired |
| Cross-game lobby | Overworld PKCE portal (`portal.beginEntry` / `completeEntry`) | not wired; this game owns its login |

## Two tokens, one endpoint

Sign-in yields an **identity session token**: account, org and app
administration, minting. It is rejected for gameplay. `mintAppToken` yields a
short-lived **app-scoped token** for one app and returns the endpoint of the
datacenter that holds that app's data. The game client is built there. Keep
them in two clients with two token stores — `NetworkManager` does.

## The presence rule

Nothing runs for an app with no player in it: schedule automations and compute
ticks fire only while someone is connected, and missed runs are not made up.
Timers fire late, not lost. Write scheduled logic to be correct whenever it
next runs rather than assuming a cadence, and note that model expressions have
no `now()` — real elapsed time needs a compute module or a server-validated
client timestamp.

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
- Game Kit: <https://docs.crowdedkingdoms.com/crowdyjs/game-kit>
- Game models: <https://docs.crowdedkingdoms.com/game-api/game-models>
- Autonomous processes: <https://docs.crowdedkingdoms.com/game-api/autonomous-processes>
- Grids and permissions: <https://docs.crowdedkingdoms.com/game-api/grids-and-permissions>
- Player code: <https://docs.crowdedkingdoms.com/game-api/player-code>
- Embed Crowdy Studio: <https://docs.crowdedkingdoms.com/crowdyjs/crowdy-studio-embed>
- Datacenter routing: <https://docs.crowdedkingdoms.com/game-api/datacenter-routing>
