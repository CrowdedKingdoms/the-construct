# @crowdedkingdoms/construct

The Construct framework: the Crowded Kingdoms platform layer and engine loop
that [the-construct](https://github.com/CrowdedKingdoms/the-construct) starter
and the games built on it share.

| Layer | What it does |
|---|---|
| `engine/` | `GameLoop`, `SceneRouter`, `Input`, `Controls`, the `GameScene` contract |
| `platform/` | Hosted sign-in and app entry (`AuthService`, `NetworkManager`), `GameSession`, World Stores presence and the pose codec, chat, voice, webcam, envScope storage |
| `platform/exec/`, `platform/model/` | The game's world hub on ck-exec (`WorldHub`, one connection per page as `NetworkManager.worldHub`) and `ModelService`, which reads the pulse, programs and progression from it |
| `platform/studio/` | The Crowdy Studio dock (the SERVER target as a ck-exec mod), grid claims and the world hub's claim registry (`GridService`), CLIENT mods for the player's grid and consented grid mods, the agent's player host |
| `grid/` | JS grid programs (`GridProgramRunner`): player JavaScript with the full CrowdyJS SDK, sandboxed, relayed with a grid-scoped token |
| `node/` | `security-headers` (site, `/dsh/`, `/grid-program.html`), `vite-plugins`, `construct-copy-dsh` |
| `sandbox/boot` | The grid program sandbox bootstrap |

It ships **TypeScript source** for Vite (it uses `?worker&url` and
`import.meta.env`). Peer dependencies: `@crowdedkingdoms/crowdyjs` 17.7+ (17.12
for `ModelService`, `GridService` and the Studio's SERVER target on ck-exec)
and, for the Studio agent pane, `@crowdedkingdoms/crowdy-dsh` 0.4+.

## Using it in a game

`ModelService` and `GridService` call a world hub on ck-exec with the endpoints
the starter's `exec/construct` serves (`world`, `programs`, `progress`,
`claims`, `record_claim`, `release_claim`). The defaults name the starter's hub,
type `world` key `main`; a game whose hub has another name says so at boot:

```ts
import { configureWorldHub, GameSession, GameLoop } from '@crowdedkingdoms/construct';

configureWorldHub({ nodeType: 'realm', key: 'main' });
```

- Set `VITE_GAME_NAME` for the Studio dock and boot card.
- Serve `grid-program.html` (a one-line page whose module imports
  `@crowdedkingdoms/construct/sandbox/boot`) and add it to
  `build.rollupOptions.input`.
- In `vite.config.ts`:

```ts
import { constructHeaderPlugins } from '@crowdedkingdoms/construct/node/vite-plugins';
import {
  dshSecurityHeaders,
  gridProgramSecurityHeaders,
  securityHeaders,
} from '@crowdedkingdoms/construct/node/security-headers';

plugins: constructHeaderPlugins({
  dshHeaders: dshSecurityHeaders({ apiOrigins: [apiOrigin] }),
  gridProgramHeaders: gridProgramSecurityHeaders(),
}),
```

- `construct-copy-dsh` (in `predev` / `prebuild`) copies the agent harness
  into `public/dsh/`.

## Setup scripts

`@crowdedkingdoms/construct/platform/onboarding/steps` provisions an app
(org, app, access tier, redirect URIs, grid claim policy, your ck-exec code
(`deployExec`: `execBuild` + `execDeploy`), a Game Model if you keep one, Studio
Common Files, agent policy). Pass your own `exec` (manifest, crates, and a
client holding your session on the app's datacenter), `blueprints` and
`commonFiles`.
