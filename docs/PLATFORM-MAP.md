# Game concept → platform surface

Where each thing a game needs lives on Crowded Kingdoms, how this repo uses it,
and where to read more. The canonical reference is
[docs.crowdedkingdoms.com](https://docs.crowdedkingdoms.com); the CrowdyJS README
and its `AGENTS.md` carry the concept→API table this one extends.

| Game concept | Platform surface | In this repo |
| --- | --- | --- |
| Accounts, sign-in | **Hosted**: `portal.signIn` → Studio `/authorize` → `portal.handleSignInCallback` — an app-scoped token, never a session | `platform/auth/AuthService.ts`, `platform/network/NetworkManager.ts`, `ui/LoginForm.ts` |
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
| Webcam | `udp.sendVideoFrame` (fragments a JPEG into `sendVideoPacket`s) / `video` notifications + `VideoFrameAssembler`; `use_video_chat` | `platform/media/WebcamService.ts`; holodeck draws the face plane (`avatars.ts#setFace`), Paint shows a camera-on ring — a 2D game decides whether to draw video |
| Player left | `actorLeft` notification (Buddy says an actor is gone, ~5 s after its last update) | `WorldStores` lane drops the actor; `WebcamService` ends the stream; scenes free per-uuid objects at once instead of after the 12 s reaper |
| Voice | `udp.sendAudioPacket` / `audio` notifications | not wired; see BWF's `VoiceChat` pattern in the docs (`WebcamService` is the same shape for video) |
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

The shell scripts (`npm run setup`, `seed`, `smoke`) run in Node, send no
`Origin` header, and therefore CAN sign in directly with `auth.login` to hold an
**identity session** -- which is what creating an org and app, seeding the model
and registering redirect URIs need. That is why Setup lives there and not in
the browser.

The app's **redirect URIs** (Studio > Apps > Settings, or `npm run setup
--origin`) are where hosted sign-in may return the player AND the API's CORS
allow-list for the app, origin-matched. A game on an unregistered origin gets
no CORS headers and a refused return leg; one fix.

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
