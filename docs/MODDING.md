# Modding with Crowdy Studio

The Construct embeds Crowdy Studio, the platform's in-game IDE. A player who
owns a grid can write Rust, compile it on the platform, and run it — as a
**SERVER** mod on ck-exec (a hub on their grid, keyed by the grid's id), or as
a **CLIENT** module in the browser sandbox. This page is the walkthrough and
the security story, in that order.

ck-exec is a dev-tier preview; so is running the SERVER target on it
(`serverEngine: 'ck-exec'` in `StudioService`, CrowdyJS 17.12). See
[Mods](https://docs.crowdedkingdoms.com/exec/mods) in the platform docs.

## Prerequisites (Setup does all of this)

| Requirement | What Setup did | Why |
| --- | --- | --- |
| Code keys on a tier | Created the *Constructor* tier with `write_server_code`, `run_server_code`, `write_client_code`, `run_client_code`, and `use_studio_agent`; granted it to you | A claim materialises only the keys your tier holds onto the grid. Building a mod needs `write_server_code`; deploying it needs that key on the grid too, and switching it on needs `run_server_code`. Agent stays off the default visitor tier. |
| Visitors may run mods | Added `run_server_code` + `run_client_code` to the default free tier | Fetching a grid's CLIENT artifact is gated on the **visitor's** tier |
| Claimable chunks | Set the grid claim policy to `SELF_CLAIM` | `claimGridChunk` refuses under other policies |
| Starter files | Published each starter template's `src/lib.rs` and `Cargo.toml`, and the fountain grid program, as Common Files | Imported copy-by-value into your projects |
| Studio Agent | Enabled the **app** Studio Agent policy and put `use_studio_agent` on Constructor | DeepSeek Harness (DSH) runs in a Web Worker inside the Studio agent pane, editing the open project (or bound GitHub repo) and testing drafts. Model tokens are billed per request to your player wallet by default (or the app's org wallet). |
| GitHub integration | Checked GitHub connection status (advisory step) | Optional. A project starts in Crowdy Studio and works there for good; when you want history and your own editor, bind a repository in hosted Studio (push the project in, or take an existing repository) and it becomes the working tree — every Studio save and every agent edit commits to it, and "Refresh from GitHub" picks up pushes made elsewhere. Unbind keeps the files. The in-game card rides the game's app token; binding itself needs your Crowded Kingdoms sign-in, so it happens in hosted Studio. |
| Cross-origin isolation | Vite sends COOP/COEP; production hosts must too ([HOSTING.md](HOSTING.md)) | The CLIENT sandbox bridge needs `SharedArrayBuffer` |

## Walkthrough: a SERVER mod everyone on your grid sees

1. In the holodeck, walk onto **Claim & Studio** and press `E`. The chunk
   becomes a one-chunk grid you own; the HUD chip shows `S wr · C wr`, and the
   Studio docks on the right. (`M` toggles it from then on.)
2. **Current project ▾ → New project…**. Name it, choose **Server**,
   *Create project*. The server module name it proposes (`<name>-server`) is
   the mod's name: 1–48 lowercase letters, digits, `-` or `_`.
3. In **Files → Common files**, add *Spinning child entrypoint* and *Spinning
   child Cargo.toml* over the blank project's two SERVER files. The blank
   project is a compute-SDK crate, which does not build as a mod; every SERVER
   starter's Cargo.toml is a `ckx-sdk` crate (the platform supplies `ckx-sdk`).
4. **Test draft** or **Run ▾ → Deploy live.** The Studio builds the crate on
   the platform (`modBuild`, the console shows the compiler), deploys it to
   your grid (`modDeploy`) and switches it on (`modSetEnabled`).
5. Stay in the chunk: a wooden post with a white hub appears in its middle,
   and a pink arm steps round it once a second. Anyone who can see the chunk
   sees the same blocks, whether or not they run CLIENT mods; the arm only
   turns while someone stands in that chunk.
6. **Live-code with the Studio Agent** in the agent pane (Constructor only).
   The agent runs the DeepSeek Harness directly in your browser. It can read
   and edit your project files (for a project bound to GitHub, each save is a commit),
   run `draft_test`, observe your surroundings with `game_observe`, and inspect
   screenshots of the game. Use the **Screenshot** button to share what you see,
   or click **Fix with AI** on any compiler diagnostic in the Problems panel.
   Model usage is metered per request at the rate card and billed to your
   player wallet by default (or the app's org wallet). Use **Account > Wallet**
   in Studio to manage funds. The agent cannot move you or act in the world;
   it only observes. When it wants to **deploy live**, the pane asks you first
   and nothing ships until you click **Deploy live** there.

A **Client** project works the same way with the *HUD greeter* starter (its
Cargo.toml declares `serde_json` and `[package.metadata.crowdy]
tick_interval_ms`: `1000` for HUD, `50` for physics minigames, `16` for
shooters). **Test draft** compiles it on the platform and starts it in your
sandbox, which writes `Welcome, <you>!` to the mod HUD. It runs in your tab
only: see [Gaps](#gaps-under-ck-exec).

## What a SERVER mod can do

A mod is a ck-exec hub, `mod:<name>` keyed by the grid's id, running as its
owner in the owner's own sandbox, within the platform's mod limits (32 MiB of
memory, 20 million fuel and 2 seconds a call, 20 calls a second, a 4 MiB
module):

- **Its grid, through the node API**: `ctx.grids().get` for its own grid,
  `ctx.world().chunk / voxels / actors / actors_near` inside the grid's
  bounds, and `ctx.world().set_voxels` (up to 16 voxels a call) inside them
  while its owner holds `update_voxel_data` there. The app's node API budget
  is shared by every hub and mod: 200 reads and 50 voxel writes a second.
- **What happens in its grid**: `Hub::on_world` receives actors moving into or
  out of a chunk (`actors`) and voxel changes (`voxels`). An actor arriving
  starts a mod that is switched on but not running. Events can be lost.
- **Timers**: `ctx.timer_every` / `ctx.timer_after`, which run only while
  players are in the app — what automations did.
- **Endpoints**: players standing in the grid call it by name,
  `exec.call(execModType('<name>'), gridId, method, args)`.
- **Nothing else**: it calls no other node, subscribes to nothing, and its
  realtime emits are dropped. When the grid changes hands its mods stop and
  become the new owner's, switched off, without their state.

The *Presence beacon* counts the players in its grid as they come and go
(`on_world`, then `world.actors`, and again every 10 s) and answers `present`
with `{ "present": n }`. See the platform's
[Mods](https://docs.crowdedkingdoms.com/exec/mods) page.

## What a CLIENT mod can do here

The SDK's `PlayerCodeBroker` allowlists and rate-limits every host call and
clamps chunk coordinates to the mod's grid. Calls it answers itself:
`grid_info` (the grid's bounds), `hud_set` (text HUD), and `overlay_draw`
(3D gizmos the holodeck renders from the same construct.scene.v1 schema —
still data, never HTML). Everything else reaches this game's router,
`packages/construct/src/platform/studio/clientModHost.ts`, which offers:

| Host call | Answer |
| --- | --- |
| `actors_list(x,y,z)` | Players in that chunk (uuid, name, position, program) |
| `actors_list_radius(x,y,z,r)` | The same across a box, clamped to the grid and r ≤ 8 |
| `chunk_get(x,y,z)` | The cached dense voxel grid, base64 |
| `voxels_list(x,y,z)` | The non-zero cells as rows |
| `voxel_set` | One voxel write through World Stores `chunks.setVoxel` + `markDirty`. Replicates to other players and persists. Args: `chunkX/Y/Z` (or `chunk`) plus in-chunk `x,y,z` (0–15) and `voxelType`. |
| `pointer_clicks` | Drain holodeck mouse clicks since the last call. `{ nowMs, buttons, holdingMs, clicks }`. `clicks` is `{ t:"down"\|"up", button, atMs, heldMs?, nx, ny }` (canvas NDC, +ny up). `holdingMs["0"]` is left-button charge time. Studio chrome is omitted. Call every `on_tick`. |

`voxel_set` is occupancy: floors, walls, claim-aligned blocks. Voxels cannot
rotate. `overlay_draw` is **local** presentation (aim assist, author preview)
for whoever is running the CLIENT companion — it is not a second replication
path.

The holodeck also renders a **replicated scene graph** (`construct.scene.v1`)
for every visitor on a grid: a mesh catalog and node list, then packed poses,
sent as realtime server events (`emit_spatial("server_event")`, payload
`[u16 eventType LE][state]`; `0xC501` a chunked UTF-8 JSON catalog
`{ v:1, revision, meshes, nodes }`, `0xC502` packed poses: u32 catalogRev, u8
count, then 24 bytes per node). Caps: 16 meshes, 64 nodes, 256 verts / 768
indices per procedural mesh, catalog ≤ 48 KiB; nodes have parent, quaternion,
scale, optional `bindActor`, and `kind` `box|sphere|cylinder|capsule|plane|mesh`.
Only a legacy player-compute SERVER module can send those events: a ck-exec mod
cannot emit, so the Studio's SERVER target no longer reaches this path.

Anything else is refused with `host call '<fn>' is not offered by this game`.
To let mods reach more of the game, add a case that goes through the same
player-authorised SDK path the human UI uses. Never hand a mod the client
object.

## Templates

SERVER starters are `ckx-sdk` crates under `exec/mods/` (`construct-beacon`,
`construct-spinning-child`, `construct-pool-cue`), built and tested with the
rest of `exec/` (`cargo test`, `cargo clippy --all-targets`, `cargo build
--release --target wasm32-unknown-unknown`). `npm run build:exec-sources`
turns them into the strings `mods/templates/exec-mods.mjs` carries, their
`ckx-sdk` line pointed at the platform's copy; the unit tests fail while that
file is stale. CLIENT starters and the fountain grid program are strings in
`mods/templates/index.mjs`. `npm run setup` and `npm run seed` publish them
all; publishing is idempotent by content.

## Gaps under ck-exec

What the port could not keep, and why:

- **Spinning child and Pool cue are voxels, not a scene graph.** The legacy
  SERVER starters drew a quaternion-animated box and a felt table with a
  procedural-mesh cue as construct.scene.v1 events. A mod's emits are dropped,
  so the ports build the same things from voxels (`world.set_voxels`): whole
  blocks in the holodeck palette, the arm or the cue stepping once a second,
  only while someone stands in the chunk (to spare the app's shared node API
  write budget), and blocks that stay in the chunk when the mod stops.
  They place themselves from the grid's low chunk instead of a `CHUNK` you
  edit, and need `update_voxel_data` on the grid, which a claim gives you.
- **Visitors do not get a ck-exec project's CLIENT half.** ck-api attaches a
  self-authored CLIENT module to the grid for visitors only when a legacy
  SERVER module that requires it is enabled; the Studio sets no pairing for a
  mod. The author runs the CLIENT half in their own tab; visitors still get
  CLIENT mods attached the legacy way.
- **Players call a mod; a CLIENT mod cannot.** The legacy beacon answered an
  invoke a CLIENT companion could route; there is no host call that reaches a
  mod, so `present` is for players (or the game) with an exec connection.
- **The blank SERVER project is not a mod.** Replace its Cargo.toml and
  src/lib.rs with a starter's.

## Security posture

- **Isolation is a prerequisite, checked at boot.** `StudioService` reads
  `crossOriginIsolated`; when false, the CLIENT half is hidden and a banner
  names the missing headers. The Playwright smoke asserts it on the served
  bundle so a hosting regression fails CI rather than a player's tab.
- **The CSP has no `unsafe-eval` and no `unsafe-inline` scripts.** Workers are
  same-origin (`worker-src 'self' blob:`); `connect-src` is the API origin plus
  its one-label zone. pixi.js runs in its CSP-safe mode for the same reason.
- **Permissions are the platform's.** The game derives SERVER/CLIENT gates from
  the exact effective keys a claim returned and never widens them; the platform
  re-checks on every build, deploy, switch, fetch and run.
- **Mods never get a token.** The glue worker is tokenless; every effect crosses
  the broker, and presentation is data the game renders as text. A SERVER mod
  runs in its owner's sandbox with its grid's capability only.
- **Trust is per author, per grid, per capability hash.** Widening a mod's
  capabilities re-prompts every visitor.
- **A build switch exists.** `VITE_CONSTRUCT_CLIENT_MODS=0` ships SERVER-only
  Studio for a fork that does not want browser execution.

### Platform status note

The platform admits CLIENT modules for any app whose tiers grant the keys —
there is no first-party allowlist — and this starter ships them **on** by
default, with the mitigations above, as the reference integration the public
docs point at. Whether to keep them on in *your* game is your call; the switch
and the SERVER-only path are here so it can be a deliberate one.

## Not wired (and where it lives)

- **The camera, for mods.** Webcam video is a host-side feature
  (`WebcamService`, `Permissions-Policy: camera=(self)`); there is no host call
  that exposes frames or the capture to a CLIENT mod, on purpose. A mod that
  wants to react to "camera on" would need a new allowlisted call in
  `clientModHost.ts`, which is your decision to make, not this starter's.

- **Marketplace listings and paid mods** — `marketplace.publishListing` and
  friends for CLIENT code, `client.exec.modPublish` / `modInstall` for mods.
  Read [Player marketplace](https://docs.crowdedkingdoms.com/game-api/player-marketplace)
  and [Mods](https://docs.crowdedkingdoms.com/exec/mods).

## JS grid programs

Beside Rust modules, a project may carry **JS grid programs**:
`programs/<name>.js` files (target CLIENT) that run in your grid with the full
CrowdyJS SDK. The server never compiles or runs them; the Construct loads one
into a hidden `sandbox="allow-scripts"` iframe (`grid-program.html`, served
with `connect-src 'none'`), and `GridProgramRunner` relays its CrowdyJS
traffic with a grid-scoped token. So a program can read and write inside the
grid, post to the grid's channels, host grid sessions and send spatial
messages that start in the grid (and reach past it), and nothing else.

```js
export default async function ({ client, grid, appId, gridId, box, log }) {
  await grid.send.text({ chunk: { x: String(box.low.x), y: String(box.low.y), z: String(box.low.z) },
                         uuid: 'f'.repeat(32), text: 'hello from the grid', distance: 2 });
}
```

The Studio agent runs one with `grid_program_run` (crowdy-dsh 0.4); the
starter's Common Files include `programs/fountain.js`. A hosting edge must
serve `grid-program.html` with `gridProgramSecurityHeaders()` and answer the
sandbox's `Origin: null` module requests with `Access-Control-Allow-Origin:
null` (the framework's Vite plugins do both for `vite dev` / `vite preview`).
