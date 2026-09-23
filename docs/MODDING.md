# Modding with Crowdy Studio

The Construct embeds Crowdy Studio, the platform's in-game IDE. A player who
owns a grid can write Rust, compile it on the platform, and run it — as a
**SERVER** module in the platform scheduler, or as a **CLIENT** module in the
browser sandbox of everyone standing on their grid. This page is the
walkthrough and the security story, in that order.

## Prerequisites (Setup does all of this)

| Requirement | What Setup did | Why |
| --- | --- | --- |
| Code keys on a tier | Created the *Constructor* tier with `write_server_code`, `run_server_code`, `write_client_code`, `run_client_code`, and `use_studio_agent`; granted it to you | A claim materialises only the keys your tier holds onto the grid. Agent stays off the default visitor tier. |
| Visitors may run mods | Added `run_server_code` + `run_client_code` to the default free tier | Fetching a grid's CLIENT artifact is gated on the **visitor's** tier |
| Claimable chunks | Set the grid claim policy to `SELF_CLAIM` | `claimGridChunk` refuses under other policies |
| Starter files | Published four common files (two templates × entrypoint + Cargo.toml) | Imported copy-by-value into your projects |
| Studio Agent | Enabled the **app** Studio Agent policy and put `use_studio_agent` on Constructor | DeepSeek Harness (DSH) runs in a Web Worker inside the Studio agent pane, editing the open project (or bound GitHub repo) and testing drafts. Model tokens are billed per request to your player wallet by default (or the app's org wallet). |
| GitHub integration | Checked GitHub connection status (advisory step) | Optional. A project starts in Crowdy Studio and works there for good; when you want history and your own editor, bind a repository in hosted Studio (push the project in, or take an existing repository) and it becomes the working tree — every Studio save and every agent edit commits to it, and "Refresh from GitHub" picks up pushes made elsewhere. Unbind keeps the files. The in-game card rides the game's app token; binding itself needs your Crowded Kingdoms sign-in, so it happens in hosted Studio. |
| Cross-origin isolation | Vite sends COOP/COEP; production hosts must too ([HOSTING.md](HOSTING.md)) | The CLIENT sandbox bridge needs `SharedArrayBuffer` |

## Walkthrough: a CLIENT mod your visitors see

1. In the holodeck, walk onto **Claim & Studio** and press `E`. The chunk
   becomes a one-chunk grid you own; the HUD chip shows `S wr · C wr`, and the
   Studio docks on the right. (`M` toggles it from then on.)
2. **Current project ▾ → New project…**. Name it, choose **Full stack**,
   *Create project*. A full-stack project pairs a SERVER module with a
   **required** CLIENT companion — and that pairing is what makes the CLIENT
   half run for visitors, not just for you (a lone CLIENT project is a private
   tool: Test/Run in your own tab only).
3. In **Files → Common files**, add the starters you need:
   *Presence beacon* (SERVER) + *HUD greeter* (CLIENT) for a hello-world
   full stack; *Spinning child* or *Pool cue* (SERVER) for a replicated 3D
   scene everyone on the grid can see. Each import proposes the right
   destination path; accept it. The Cargo.toml matters: the blank project
   declares only `crowdy-compute-sdk`, and `host_call` takes a
   `serde_json::Value`. CLIENT crates also declare
   `[package.metadata.crowdy] tick_interval_ms` (default `1000` for HUD;
   use `50` for physics minigames, `16` for shooters). Studio Test/Deploy
   reads it when starting that mod's browser worker.
4. **Test draft.** Both targets compile on the platform (`cargo build
   --offline`, then metering and optimisation). The console shows the build;
   the greeter starts in your sandbox and writes to the mod HUD:
   `Welcome, <you>!`.
5. **Live-code with the Studio Agent** in the agent pane (Constructor only).
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
6. **Run ▾ → Deploy live.** The SERVER module is now scheduled while your app
   has players, and its CLIENT companion is attached to your grid.
7. Have someone else walk onto your chunk. They are asked once to trust your
   mods (the aggregate capability summary is shown); after that the greeter
   runs in *their* browser and greets both of you. Change the code and deploy
   again: the capability hash changes, and they are asked again.

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

The shared 3D world is a **SERVER-owned scene graph** (`construct.scene.v1`).
A SERVER module writes a mesh catalog and node list, then emits packed poses.
The holodeck renders those instances for **every visitor on the grid**, even
if they declined CLIENT mods. Caps: 16 meshes, 64 nodes, 256 verts / 768
indices per procedural mesh, catalog ≤ 48 KiB. Nodes have parent, quaternion,
scale, optional `bindActor` (follow a player's pose), and `kind`
`box|sphere|cylinder|capsule|plane|mesh`.

Wire (SERVER `emit_spatial("server_event")`, payload `[u16 eventType LE][state]`):

- `0xC501` — chunked UTF-8 JSON catalog (`{ v:1, revision, meshes, nodes }`)
- `0xC502` — packed poses (u32 catalogRev, u8 count, then 24 bytes per node)

Starters **Spinning child** and **Pool cue** show the path. Replace `CHUNK`
with your claim's low corner.

Anything else is refused with `host call '<fn>' is not offered by this game`.
To let mods invoke model functions, add a case that goes through the same
player-authorised SDK path the human UI uses. Never hand a mod the client
object.

## What a SERVER mod can do

Everything the compute SDK's `api` offers, as the grid owner, only while the
app has players (the presence rule), within the fuel and quota policy the app
sets. The *Presence beacon* template counts actors each tick and answers an
invoke with the count. See the platform docs:
[Player code](https://docs.crowdedkingdoms.com/game-api/player-code).

## Templates

`mods/templates/index.mjs` holds the starters as plain strings so the browser
`npm run setup` and `npm run seed` publish the same bytes. Add a template there and
re-run `npm run seed`; publishing is idempotent by content.

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
  re-checks on every deploy, fetch and run.
- **Mods never get a token.** The glue worker is tokenless; every effect crosses
  the broker, and presentation is data the game renders as text.
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
  friends. Read [Player marketplace](https://docs.crowdedkingdoms.com/game-api/player-marketplace).

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
