# @crowdedkingdoms/construct

The Construct framework: the Crowded Kingdoms platform layer and engine loop
that [the-construct](https://github.com/CrowdedKingdoms/the-construct) starter
and the games built on it share.

| Layer | What it does |
|---|---|
| `engine/` | `GameLoop`, `SceneRouter`, `Input`, `Controls`, the `GameScene` contract |
| `platform/` | Hosted sign-in and app entry (`AuthService`, `NetworkManager`), `GameSession`, World Stores presence and the pose codec, chat, voice, webcam, envScope storage |
| `platform/studio/` | The Crowdy Studio dock, grid claims (`GridService`), CLIENT mods for the player's grid and consented grid mods, the agent's player host |
| `grid/` | JS grid programs (`GridProgramRunner`): player JavaScript with the full CrowdyJS SDK, sandboxed, relayed with a grid-scoped token |
| `node/` | `security-headers` (site, `/dsh/`, `/grid-program.html`), `vite-plugins`, `construct-copy-dsh` |
| `sandbox/boot` | The grid program sandbox bootstrap |

It ships **TypeScript source** for Vite (it uses `?worker&url` and
`import.meta.env`). Peer dependencies: `@crowdedkingdoms/crowdyjs` 17.7+ and,
for the Studio agent pane, `@crowdedkingdoms/crowdy-dsh` 0.4+.

## Using it in a game

```ts
import { configureGameModel, GameSession, GameLoop } from '@crowdedkingdoms/construct';
import { MODEL_NAMES, kitOptions } from './model/blueprints.mjs';

configureGameModel({ names: MODEL_NAMES, kitOptions: kitOptions() });
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
(org, app, access tier, redirect URIs, grid claim policy, model, Studio
Common Files, agent policy). Pass your own `blueprints` and `commonFiles`.
