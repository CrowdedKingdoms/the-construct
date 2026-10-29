# STUDIO.md

Guidance for Crowdy Studio's in-browser agent editing this game. The agent
reads this file as its instructions when the game is open in the game editor.
A developer working in a checkout reads `AGENTS.md` instead.

## What you are editing

The files are this game's repository, as a draft only this player sees.
Nothing reaches GitHub until the player asks you to commit, and then they
confirm it.

The running world reloads the **content layer** from the draft:
`src/game/content.ts` and every file it imports. That covers:

- `src/scenes/` — one directory per scene; a scene implements `GameScene`
  (`@crowdedkingdoms/construct/engine/GameScene`, see
  `docs/RENDERER-ADAPTER.md`).
- `src/game/programs.ts` — the programs players can load from home, with each
  pad's position and colour.
- `model/catalog.mjs` — the program list the world hub serves too.
- `src/game/content.ts` — the registry the game is built from (`contentApi: 1`):
  the scenes, the home scene and spawn, and the programs.

Outside the content layer a change needs a rebuild or a deploy, and
`preview_status` says so:

- `src/main.ts`, `src/ui/`, `src/style.css`: the host and its HUD. Ask the
  player to reload the page (local) or to build the game and upload it to their
  host again (deployed).
- `exec/`: the world hub (Rust). The hub runs on the platform; a change there
  needs `npm run build:exec-sources` and `npm run deploy:exec`, which this
  session cannot run.
- `packages/construct/`: the framework every game shares. Leave it alone
  unless the player asks.

## Adding a scene

1. Add `src/scenes/<name>/<Name>Scene.ts` implementing `GameScene`. Reuse what
   the existing scenes import; a deployed game can load only packages its build
   already bundles.
2. Register it in `src/game/content.ts` under its scene id.
3. If players load it from home, add a row to `PROGRAM_CATALOG` in
   `model/catalog.mjs` (a new `programId`, 1-255) and a pad for its scene id
   in `src/game/programs.ts`.
4. Call `preview_status` and fix what it reports before you say it works.

Keep scenes display-only for anything a player could cheat: the world hub
decides rules, and scenes show its answers.

## Working rules

- Read a file before you change it; a write the player changed meanwhile fails
  as stale, and you read it again.
- After a change to the content layer, call `preview_status`.
- Commit only when the player asks, with a message that says what changed.
- No shell here: say what the player should run when a change needs a build, a
  test or a deploy.
