# Modding with Crowdy Studio

The Construct embeds Crowdy Studio, the platform's in-game IDE. A player who
owns a grid can write Rust, compile it on the platform, and run it — as a
**SERVER** module in the platform scheduler, or as a **CLIENT** module in the
browser sandbox of everyone standing on their grid. This page is the
walkthrough and the security story, in that order.

## Prerequisites (Setup does all of this)

| Requirement | What Setup did | Why |
| --- | --- | --- |
| Code keys on a tier | Created the *Constructor* tier with `write_server_code`, `run_server_code`, `write_client_code`, `run_client_code`; granted it to you | A claim materialises only the keys your tier holds onto the grid |
| Visitors may run mods | Added `run_server_code` + `run_client_code` to the default free tier | Fetching a grid's CLIENT artifact is gated on the **visitor's** tier |
| Claimable chunks | Set the grid claim policy to `SELF_CLAIM` | `claimGridChunk` refuses under other policies |
| Starter files | Published four common files (two templates × entrypoint + Cargo.toml) | Imported copy-by-value into your projects |
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
3. In **Files → Common files**, add all four starters to the project:
   *Presence beacon entrypoint* + *Presence beacon Cargo.toml* (SERVER),
   *HUD greeter entrypoint* + *HUD greeter Cargo.toml* (CLIENT). Each import
   proposes the right destination path; accept it. The Cargo.toml matters: the
   blank project declares only `crowdy-compute-sdk`, and `host_call` takes a
   `serde_json::Value`.
4. **Test draft.** Both targets compile on the platform (`cargo build
   --offline`, then metering and optimisation). The console shows the build;
   the greeter starts in your sandbox and writes to the mod HUD:
   `Welcome, <you>!`.
5. **Run ▾ → Deploy live.** The SERVER module is now scheduled while your app
   has players, and its CLIENT companion is attached to your grid.
6. Have someone else walk onto your chunk. They are asked once to trust your
   mods (the aggregate capability summary is shown); after that the greeter
   runs in *their* browser and greets both of you. Change the code and deploy
   again: the capability hash changes, and they are asked again.

## What a CLIENT mod can do here

The SDK's `PlayerCodeBroker` allowlists and rate-limits every host call and
clamps chunk coordinates to the mod's grid. Two calls it answers itself:
`grid_info` (the grid's bounds) and `hud_set` (presentation — rendered by the
game as text, never HTML). Everything else reaches this game's router,
`src/platform/studio/clientModHost.ts`, which offers exactly:

| Host call | Answer |
| --- | --- |
| `actors_list(x,y,z)` | Players in that chunk (uuid, name, position, program) |
| `actors_list_radius(x,y,z,r)` | The same across a box, clamped to the grid and r ≤ 8 |
| `chunk_get(x,y,z)` | The cached dense voxel grid, base64 |
| `voxels_list(x,y,z)` | The non-zero cells as rows |

Anything else is refused with `host call '<fn>' is not offered by this game`.
To let mods do more (write voxels, invoke model functions), add a case that
goes through the same player-authorised SDK path the human UI uses. Never hand
a mod the client object.

## What a SERVER mod can do

Everything the compute SDK's `api` offers, as the grid owner, only while the
app has players (the presence rule), within the fuel and quota policy the app
sets. The *Presence beacon* template counts actors each tick and answers an
invoke with the count. See the platform docs:
[Player code](https://docs.crowdedkingdoms.com/game-api/player-code).

## Templates

`mods/templates/index.mjs` holds the starters as plain strings so the browser
wizard and `npm run seed` publish the same bytes. Add a template there and
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

Crowded Kingdoms' player-compute program tracked CLIENT-mod rollout beyond its
first-party pilot under a security gate (an external review of the sandbox
bridge and money paths). The platform admits CLIENT modules for any app whose
tiers grant the keys — there is no first-party allowlist — and this starter
demonstrates the full path with the mitigations above. Whether to enable CLIENT
mods in *your* game is your call; the switch and the SERVER-only path are here
so it can be a deliberate one.

## Not wired (and where it lives)

- **The Studio agent dock** (Ask/Build/Play) needs a platform-level policy an
  operator arms and a `playerHost` adapter the game implements. This starter
  omits `crowdyStudioAgent`, so the dock stays hidden and fail-closed.
- **Marketplace listings and paid mods** — `marketplace.publishListing` and
  friends. Read [Player marketplace](https://docs.crowdedkingdoms.com/game-api/player-marketplace).
