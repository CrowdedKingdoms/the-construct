/**
 * The Construct's starter Crowdy Studio projects.
 *
 * Each is a tiny, deployable Rust module a player can open from the Studio's
 * Common Files, read in one sitting, deploy, and see do something. The seed
 * publishes their `src/lib.rs` into the app's immutable common-file catalog
 * (`crowdyStudioCommonPublish`), where import is copy-by-value, so a later
 * seed never edits a player's project behind their back.
 *
 * SERVER starters are ck-exec mods: `ckx-sdk` crates under `exec/mods/`, built
 * and tested with the rest of `exec/`, and carried here as strings by the
 * generated `exec-mods.mjs` (`npm run build:exec-sources`). CLIENT starters are
 * a mod's CLIENT half: one `crowdy-client-sdk` crate each, which the platform
 * builds for the browser and the mod's grid serves to the players standing in
 * it who consent. They live below as strings.
 *
 * Plain ES module: shared by `scripts/setup.mjs`, `seed.mjs` and `smoke.mjs`.
 */
import { EXEC_MOD_SOURCES } from './exec-mods.mjs';

/** crowdy-client-sdk; the platform's build points this line at its own copy. */
const CLIENT_SDK_VERSION = '0.1.0';

/**
 * A CLIENT half's Cargo.toml, within the platform build's rules: `[package]`,
 * `[lib]` as a cdylib, `[package.metadata.crowdy] tick_interval_ms`, and
 * dependencies on crowdy-client-sdk and serde_json only.
 */
function clientCargo(name, tickIntervalMs) {
  return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

# How often each visitor's browser calls tick (clamped 16–1000 ms).
# 1000 = HUD/text. 50 = physics minigames (pool). 16 = shooters, if a tick stays cheap.
[package.metadata.crowdy]
tick_interval_ms = ${tickIntervalMs}

[dependencies]
crowdy-client-sdk = "${CLIENT_SDK_VERSION}"
serde_json = "1"
`;
}

/**
 * CLIENT: asks the broker for the grid's bounds (`grid_info`, answered in the
 * browser), lists the players standing in the grid's first chunk
 * (`actors_list`, answered by the game's host-call router) and greets them
 * through `hud_set`. Presentation crosses as data; the game renders it as
 * text, never HTML.
 */
const HUD_GREETER = `//! HUD greeter: the CLIENT half of a mod. It runs in the browser of each player who stands in
//! the mod's grid and consents to it (or trusts you), and greets whoever is in the grid's first
//! chunk in the mod HUD.

use crowdy_client_sdk as crowdy;
use serde_json::{json, Value};

/// The grid's low chunk. The broker answers grid_info with decimal strings.
fn grid_origin() -> Option<(i64, i64, i64)> {
    let info = crowdy::api::grid_info().ok()?;
    let low = info.get("low")?;
    let coord = |axis: &str| low.get(axis)?.as_str()?.parse::<i64>().ok();
    Some((coord("x")?, coord("y")?, coord("z")?))
}

fn init() {
    crowdy::log(1, "hud greeter ready");
}

fn tick(_dt_ms: u32) {
    let Some((x, y, z)) = grid_origin() else { return };
    let actors = crowdy::api::actors_list(x, y, z).unwrap_or_else(|_| json!({ "actors": [] }));
    let rows = actors.get("actors").and_then(Value::as_array).cloned().unwrap_or_default();
    let names: Vec<&str> = rows
        .iter()
        .filter_map(|row| row.get("name")?.as_str())
        .filter(|name| !name.is_empty())
        .collect();
    let greeting = if names.is_empty() {
        "Nobody here yet.".to_string()
    } else {
        format!("Welcome, {}!", names.join(", "))
    };
    // The game owns the HUD; this payload is rendered as text.
    let _ = crowdy::api::hud_set(json!({ "greeting": greeting, "here": rows.len(), "chunk": [x, y, z] }));
    // Mouse: crowdy::api::pointer_clicks() each tick drains { clicks, buttons, holdingMs }.
    // Click-to-charge = left down, holdingMs["0"] while held, fire on up.
}

fn invoke(payload: &[u8]) -> Vec<u8> {
    payload.to_vec()
}

crowdy::register_module!(init: init, tick: tick, invoke: invoke);
`;

/**
 * CLIENT: places one voxel in the middle of the grid's first chunk, as the
 * player running it, so everyone sees a real block in the holodeck and not only
 * HUD text. `voxel_set` goes through the chunk store (the path Paint uses).
 */
const VOXEL_MARKER = `//! Voxel marker: the CLIENT half of a mod. In the browser of each player who stands in the mod's
//! grid and consents to it, it places one block in the middle of the grid's first chunk, once per
//! visit, as that player: it needs their update_voxel_data on the grid, and the HUD says whether
//! it could.

use crowdy_client_sdk as crowdy;
use serde_json::{json, Value};

/// The holodeck palette's stone.
const MARKER: i32 = 1;
/// The state blob lives as long as the page's worker: one attempt per visit.
const TRIED: &[u8] = b"tried";

/// The grid's low chunk. The broker answers grid_info with decimal strings.
fn grid_origin() -> Option<(i64, i64, i64)> {
    let info = crowdy::api::grid_info().ok()?;
    let low = info.get("low")?;
    let coord = |axis: &str| low.get(axis)?.as_str()?.parse::<i64>().ok();
    Some((coord("x")?, coord("y")?, coord("z")?))
}

fn init() {}

fn tick(_dt_ms: u32) {
    if crowdy::state_get() == TRIED {
        return;
    }
    let Some(chunk) = grid_origin() else { return };
    crowdy::state_set(TRIED);
    let text = match crowdy::api::voxel_set(chunk, (8, 1, 8), MARKER, None) {
        Ok(reply) if reply.get("ok").and_then(Value::as_bool) != Some(false) => {
            "Marker placed in the middle of the grid.".to_string()
        }
        Ok(_) => "The marker was not placed here.".to_string(),
        Err(error) => format!("The marker was not placed: {error}"),
    };
    let _ = crowdy::api::hud_set(json!({ "greeting": text }));
}

fn invoke(payload: &[u8]) -> Vec<u8> {
    payload.to_vec()
}

crowdy::register_module!(init: init, tick: tick, invoke: invoke);
`;

/** A SERVER starter's files: the crate in `exec/mods/<id>`, as Common Files carry it. */
function serverMod(id) {
  const files = EXEC_MOD_SOURCES[id];
  if (!files) throw new Error(`no exec/mods/${id}: run npm run build:exec-sources`);
  return Object.entries(files).map(([path, content]) => ({ path, content }));
}

/** @type {import('./index.d.mts').StarterTemplate[]} */
export const STARTER_TEMPLATES = [
  {
    id: 'construct-hud-greeter',
    title: 'HUD greeter',
    target: 'CLIENT',
    description:
      "A mod's CLIENT half that reads who is standing in your grid and greets them in the mod HUD, " +
      'in the browser of everyone there who consents to it. Start here for CLIENT mods.',
    files: [
      { path: 'Cargo.toml', content: clientCargo('construct-hud-greeter', 1000) },
      { path: 'src/lib.rs', content: HUD_GREETER },
    ],
  },
  {
    id: 'construct-beacon',
    title: 'Presence beacon',
    target: 'SERVER',
    description:
      'A mod (ck-exec) that counts the players in your grid as they come and go and answers ' +
      '`present` with the count. Start here for SERVER mods.',
    files: serverMod('construct-beacon'),
  },
  {
    id: 'construct-voxel-marker',
    title: 'Voxel marker',
    target: 'CLIENT',
    description:
      "A mod's CLIENT half that places one voxel in the centre of your grid, as the player running " +
      'it. Other players see the block in the holodeck because it writes the shared chunk store, ' +
      'not a private HUD.',
    files: [
      { path: 'Cargo.toml', content: clientCargo('construct-voxel-marker', 1000) },
      { path: 'src/lib.rs', content: VOXEL_MARKER },
    ],
  },
  {
    id: 'construct-spinning-child',
    title: 'Spinning child',
    target: 'SERVER',
    description:
      'A mod (ck-exec) that builds a post with an arm swinging round it from voxels in the middle ' +
      'of your grid, a quarter turn a second while someone is there. Every visitor sees it; ' +
      'nobody has to trust or run a CLIENT half.',
    files: serverMod('construct-spinning-child'),
  },
  {
    id: 'construct-pool-cue',
    title: 'Pool cue',
    target: 'SERVER',
    description:
      'A mod (ck-exec) that builds a pool table with three balls from voxels and strokes a cue ' +
      'at the white ball while someone is there. Passers-by who never accepted CLIENT see it too.',
    files: serverMod('construct-pool-cue'),
  },
];

/**
 * The common-file form of a template, ready for `crowdyStudioCommonPublish`.
 *
 * Two entries per template: the entrypoint AND its Cargo.toml, because the
 * crate's dependencies and tick travel in it. A CLIENT crate is a
 * `crowdy-client-sdk` crate with `serde_json` (measured on 2026-09-07 as
 * `E0432: unresolved import serde_json` when only the entrypoint was imported);
 * a SERVER crate is a `ckx-sdk` mod. Players add both files over a new
 * project's; each import defaults to the right destination path.
 */
export function commonFilesFor(template) {
  const entrypoint = template.files.find((file) => file.path === 'src/lib.rs');
  const cargo = template.files.find((file) => file.path === 'Cargo.toml');
  if (!entrypoint || !cargo) throw new Error(`${template.id} needs src/lib.rs and Cargo.toml`);
  const tags = ['crowdy-studio', 'the-construct', template.target.toLowerCase(), 'starter'];
  return [
    {
      slug: template.id,
      title: `${template.title} entrypoint`,
      description:
        `${template.description} Add this src/lib.rs AND the matching "${template.title} Cargo.toml" ` +
        `to a ${template.target} project, then Test draft.`,
      path: 'src/lib.rs',
      target: template.target,
      tags,
      content: entrypoint.content,
    },
    {
      slug: `${template.id}-cargo`,
      title: `${template.title} Cargo.toml`,
      description:
        template.target === 'SERVER'
          ? `Cargo.toml for "${template.title}": a ckx-sdk mod (the platform supplies ckx-sdk) with serde.`
          : `Cargo.toml for "${template.title}": a mod's CLIENT half on crowdy-client-sdk (the platform supplies it) with serde_json.`,
      path: 'Cargo.toml',
      target: template.target,
      tags: [...tags, 'cargo'],
      content: cargo.content,
    },
  ];
}

/** Back-compat alias: the entrypoint entry only. */
export function commonFileFor(template) {
  return commonFilesFor(template)[0];
}

/**
 * JS grid programs (DN-10): plain JavaScript a player runs INSIDE their grid
 * with the full CrowdyJS SDK. The Studio agent runs one with
 * `grid_program_run`; the Construct loads it into a network-less sandbox whose
 * only way out is a grid-scoped relay. A program is a module whose default
 * export receives `{ client, grid, appId, gridId, box, log }`.
 */
export const PROGRAM_TEMPLATES = [
  {
    id: 'construct-fountain-program',
    title: 'Fountain (JS grid program)',
    description:
      'Speaks from the middle of your grid every few seconds (heard up to two chunks past its edge) ' +
      'and notices wishes said nearby.',
    path: 'programs/fountain.js',
    content: `// A JS grid program: it runs in YOUR grid, with the full CrowdyJS SDK.
// Everything it sends starts inside the grid; the server refuses the rest.
export default async function ({ client, grid, appId, box, log }) {
  log(\`fountain running in grid \${grid.gridId}\`);
  const uuid = 'f'.repeat(32);
  const centre = { x: String(box.low.x), y: String(box.low.y), z: String(box.low.z) };

  // Heard by anyone within two chunks, even outside the grid.
  setInterval(() => {
    grid.send
      .text({ chunk: centre, uuid, text: 'the fountain gurgles', distance: 2 })
      .catch((error) => log('send failed:', error.message));
  }, 5_000);

  // Chat said near the grid reaches the program too.
  client.udp.subscribe(
    {
      text: (note) => {
        if (/wish/i.test(note.text ?? '')) log('someone made a wish:', note.text);
      },
    },
    appId,
  );
}
`,
  },
];

/** Common Files for the JS grid program templates (target CLIENT, under programs/). */
export function programCommonFiles() {
  return PROGRAM_TEMPLATES.map((program) => ({
    slug: program.id,
    title: program.title,
    description: `${program.description} Add it to a project as ${program.path}, then ask the agent to run it.`,
    path: program.path,
    target: 'CLIENT',
    tags: ['crowdy-studio', 'the-construct', 'grid-program', 'starter'],
    content: program.content,
  }));
}
