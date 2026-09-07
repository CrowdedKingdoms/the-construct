# The Construct

A starter repository for building browser games on [Crowded Kingdoms](https://docs.crowdedkingdoms.com)
with the [CrowdyJS](https://github.com/CrowdedKingdoms/CrowdyJS) SDK.

The SDK gives you the platform. This repo gives you the rest of a game: an
engine-agnostic platform layer, two renderers driven by the same session, a
server-authoritative game model, an in-game Crowdy Studio IDE where players
write and run their own mods, and a Setup wizard that creates your org and app
on Crowded Kingdoms from inside the game — no card, no operator, no infra.

Clone it, run it, then replace the demo scenes with your game.

## What you get

| Area | What it is | Where |
| --- | --- | --- |
| Holodeck | A three.js hub where players arrive, see each other, chat, and step on pads | `src/scenes/holodeck-three/` |
| Paint | A pixi.js program: a shared canvas painted with persisted voxels | `src/scenes/program-pixi/` |
| Platform layer | Sign-in, app entry, presence, chunks, save state, chat, model, Studio — engine-agnostic | `src/platform/` |
| Adapter boundary | The small `GameScene` contract both renderers implement | `src/engine/`, [docs/RENDERER-ADAPTER.md](docs/RENDERER-ADAPTER.md) |
| Crowdy Studio | The in-game IDE: players claim a chunk and write SERVER + CLIENT Rust mods | `src/platform/studio/`, [docs/MODDING.md](docs/MODDING.md) |
| Game model | Kit blueprints (progression, leaderboards) + a hand-authored catalog, seeded idempotently | `model/blueprints.mjs` |
| Setup wizard | Register → org → free app → access tier → seed → Studio starter files, in the browser or from a shell | `src/platform/onboarding/`, `scripts/setup.mjs` |
| Security headers | COOP/COEP/CSP that make CLIENT mods possible, wired into Vite and documented per host | `security-headers.mjs`, [docs/HOSTING.md](docs/HOSTING.md) |

## Ten minutes to a running game

Prerequisites: Node 20+ and a modern browser. Nothing else.

```bash
git clone https://github.com/CrowdedKingdoms/the-construct.git
cd the-construct
npm install
npm run dev
```

Open <http://localhost:5175>.

1. **Create an account** (or continue as a guest). Accounts live on Crowded
   Kingdoms; the game stores only a session token in your browser.
2. **Setup** opens because this browser has no app yet. Keep the defaults and
   press *Create my app*. Seven idempotent steps run: organization, free app on
   shared hosting, a *Constructor* access tier with the Crowdy Studio code
   keys, an app token, the self-claim grid policy, the game model, and the
   Studio starter files. It prints an app id.
3. **Enter The Construct.** You are in the holodeck. `WASD` moves, click to
   look, `T` chats, `E` on a pad. Open a second browser (or a friend does) and
   sign in with `?app=<your id>` — you see each other.
4. Step on **Load: Paint** and press `E`: the pixi.js program. Click to paint;
   the cells replicate live and persist.
5. Step on **Claim & Studio** and press `E`: you claim the chunk you stand on
   and Crowdy Studio opens beside the game. Follow [docs/MODDING.md](docs/MODDING.md)
   to deploy a mod that runs in the browser — yours and your visitors'.

To pin this checkout to your app, copy `.env.example` to `.env.local` and set
`VITE_APP_ID`. Everything else is optional: the installed SDK build already
knows the API origin for its tier.

## Command reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with the production security headers |
| `npm run build` / `npm run preview` | Production bundle, and serve it locally with the same headers |
| `npm test` | Unit tests (vitest) + CSP builder tests (`node --test`) |
| `npm run test:e2e` | Playwright: boots cross-origin isolated; with `CONSTRUCT_E2E=1` and credentials, signs in and opens Studio |
| `npm run lint` / `npm run typecheck` / `npm run format:check` | Quality gates CI runs |
| `npm run setup -- --org "…" --app "…"` | Headless Setup (same code as the wizard); needs `CONSTRUCT_EMAIL` / `CONSTRUCT_PASSWORD` |
| `npm run seed` | Re-deploy the model + Studio starter files to `APP_ID` after editing `model/` or `mods/` |
| `npm run smoke` | Verify an app has everything Setup should have produced |
| `npm run check:pin` | The CrowdyJS pin is exact and matches the branch tier |

## How it is put together

```mermaid
flowchart LR
  subgraph platform [src/platform — engine agnostic]
    Net[NetworkManager]
    Stores[WorldStores]
    Session[GameSession]
    Studio[StudioService]
    Model[ModelService]
    Onb[onboarding]
  end
  subgraph engine [src/engine]
    Loop[GameLoop]
    Router[SceneRouter]
    Input[Input]
  end
  Holo[holodeck-three] --> Router
  Paint[program-pixi] --> Router
  Router --> Session
  Loop --> Session
  Session --> Stores --> Net
  Studio --> Net
  Model --> Net
  Onb --> Net
  Net -->|GraphQL + realtime| CK[Crowded Kingdoms]
```

- Two tokens, one endpoint: an identity session for account and admin work,
  a short-lived app-scoped token per game for everything else. `NetworkManager`
  owns both. Scenes never see a token.
- The loop reads the active scene's `localPose()` every frame and hands it to
  the replication store, which sends at 5 Hz on change. Scenes render other
  players from `session.players()`. That is the whole adapter boundary.
- The browser presents intent and renders results. Inventories, scores,
  grids, and who may run code are decided server-side by the game model and
  the platform. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, authority, the boot sequence, what is generic and what is demo
- [docs/RENDERER-ADAPTER.md](docs/RENDERER-ADAPTER.md) — replacing a scene or the whole renderer
- [docs/PLATFORM-MAP.md](docs/PLATFORM-MAP.md) — game concept → platform surface, with links to the public docs
- [docs/MODDING.md](docs/MODDING.md) — Crowdy Studio: permissions, the CLIENT mod sandbox, templates, visitors, security posture
- [docs/NEW-GAME-CHECKLIST.md](docs/NEW-GAME-CHECKLIST.md) — turning this into your game
- [docs/HOSTING.md](docs/HOSTING.md) — static hosting with the headers CLIENT mods require
- [CHANGELOG.md](CHANGELOG.md)

## Free tier, plainly

A new organization gets free apps on shared hosting (three by default) with
monthly allowances per app (egress, ingress, compute hours, storage). Nothing
here asks for a card. Sustained usage above the allowances bills the org
wallet; a player's mods have a free monthly compute trial before their own
wallet is involved. Current figures: [Shared environment](https://docs.crowdedkingdoms.com/management-api/shared-environment)
and [Player billing](https://docs.crowdedkingdoms.com/management-api/player-billing).

## Hosting is yours

This repo deploys nothing. `npm run build` produces a static site you can put
anywhere — with one requirement: the host must send the COOP/COEP headers or
CLIENT mods will not run (the game says so on screen). Recipes in
[docs/HOSTING.md](docs/HOSTING.md).

## Branches and the SDK pin

`dev`, `test` and `prod` track the three Crowded Kingdoms tiers. Each pins the
exact CrowdyJS build published for its tier (`X.Y.Z-dev.N`, `X.Y.Z-test.N`,
`X.Y.Z`), because each build carries its tier's API origin. **Clone `prod`**
unless you are working with the platform team. `npm run check:pin` enforces it.

## License

MIT — see [LICENSE](LICENSE). The Crowded Kingdoms platform and the CrowdyJS
SDK have their own terms.
