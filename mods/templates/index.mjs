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
 * generated `exec-mods.mjs` (`npm run build:exec-sources`). CLIENT starters run
 * in the browser sandbox on the compute SDK and live below as strings.
 *
 * Plain ES module: shared by `scripts/setup.mjs`, `seed.mjs` and `smoke.mjs`.
 */
import { EXEC_MOD_SOURCES } from './exec-mods.mjs';

const SDK_VERSION = '0.1.5';

function cargo(name, extraDeps = '', tickIntervalMs = null) {
  const tick =
    tickIntervalMs == null
      ? ''
      : `
# How often the browser calls CLIENT on_tick (clamped 16–1000 ms).
# 1000 = HUD/text. 50 = physics minigames (pool). 16 = shooters, if a tick stays cheap.
[package.metadata.crowdy]
tick_interval_ms = ${tickIntervalMs}
`;
  return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
${tick}
[dependencies]
crowdy-compute-sdk = "${SDK_VERSION}"
${extraDeps}`;
}

const SERDE_JSON_DEP = 'serde_json = "1"\n';

/**
 * CLIENT: runs in the visitor's browser sandbox. Asks the host for its own
 * grid bounds (`grid_info`, answered locally by the broker), lists the actors
 * standing in the grid's first chunk (`actors_list`, routed to the game's
 * allowlisted host-call router) and renders a greeting through `hud_set`.
 * Presentation crosses as data; the game renders it as text, never HTML.
 */
const HUD_GREETER = `use crowdy_compute_sdk::{api, host_call};
use serde_json::json;

fn grid_origin() -> Option<(i64, i64, i64)> {
    let info = host_call("grid_info", json!({})).ok()?;
    let low = info.get("low")?;
    let parse = |v: &serde_json::Value| v.as_str()?.parse::<i64>().ok();
    Some((parse(low.get("x")?)?, parse(low.get("y")?)?, parse(low.get("z")?)?))
}

fn on_init() {}

fn on_tick(_dt: u32) {
    let Some((x, y, z)) = grid_origin() else { return };
    let actors = api::actors_list(x, y, z).unwrap_or_else(|_| json!({ "actors": [] }));
    let rows = actors.get("actors").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let names: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .filter(|n| !n.is_empty())
        .collect();
    let greeting = if names.is_empty() {
        "Nobody here yet.".to_string()
    } else {
        format!("Welcome, {}!", names.join(", "))
    };
    // The host owns the HUD; this payload is rendered as text.
    let _ = host_call(
        "hud_set",
        json!({ "payload": { "greeting": greeting, "here": rows.len(), "chunk": [x, y, z] } }),
    );
    // Mouse: crowdy::api::pointer_clicks() each tick. Drain {clicks, buttons,
    // holdingMs}. Click-to-charge = left down, holdingMs["0"] while held, fire on up.
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/**
 * CLIENT: plants one voxel in the middle of the owned grid so visitors see a
 * real block in the holodeck, not only HUD text. `voxel_set` replicates
 * through the chunk store (same path as Paint).
 */
const VOXEL_MARKER = `use crowdy_compute_sdk::host_call;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

static PLACED: AtomicBool = AtomicBool::new(false);

fn grid_origin() -> Option<(i64, i64, i64)> {
    let info = host_call("grid_info", json!({})).ok()?;
    let low = info.get("low")?;
    let parse = |v: &serde_json::Value| v.as_str()?.parse::<i64>().ok();
    Some((parse(low.get("x")?)?, parse(low.get("y")?)?, parse(low.get("z")?)?))
}

fn on_init() {}

fn on_tick(_dt: u32) {
    if PLACED.load(Ordering::Relaxed) {
        return;
    }
    let Some((x, y, z)) = grid_origin() else { return };
    let result = host_call(
        "voxel_set",
        json!({
            "chunkX": x,
            "chunkY": y,
            "chunkZ": z,
            "x": 8,
            "y": 1,
            "z": 8,
            "voxelType": 1
        }),
    );
    if result.is_ok() {
        PLACED.store(true, Ordering::Relaxed);
    }
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
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
      'A browser mod that reads who is standing in your grid and greets them in the mod HUD. ' +
      'Start here for CLIENT mods.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-hud-greeter', SERDE_JSON_DEP, 1000) },
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
      'Places one voxel in the centre of your grid. Other players see the block in the holodeck ' +
      'because it writes the shared chunk store, not a private HUD.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-voxel-marker', SERDE_JSON_DEP, 1000) },
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
      'nobody has to trust or run a CLIENT companion.',
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
 * crate's dependencies travel in it. A CLIENT crate declares `serde_json` beside
 * the compute SDK (measured on 2026-09-07 as `E0432: unresolved import
 * serde_json` when only the entrypoint was imported); a SERVER crate is a
 * `ckx-sdk` mod, which the Studio's blank SERVER project is not. Players add
 * both files; each import defaults to the right destination path.
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
          : `Cargo.toml for "${template.title}": declares serde_json beside the compute SDK.`,
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
