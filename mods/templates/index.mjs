/**
 * The Construct's starter Crowdy Studio projects.
 *
 * Each is a tiny, deployable Rust module a player can open from the Studio's
 * Common Files, read in one sitting, deploy, and see do something. The seed
 * publishes their `src/lib.rs` into the app's immutable common-file catalog
 * (`crowdyStudioCommonPublish`), where import is copy-by-value, so a later
 * seed never edits a player's project behind their back.
 *
 * Plain ES module: shared by the browser wizard and `scripts/seed.mjs`.
 */

const SDK_VERSION = '0.1.5';

function cargo(name, extraDeps = '') {
  return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

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
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> { Vec::new() }

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

/**
 * SERVER: runs in the platform scheduler as the grid owner, only while the
 * app has players. Counts the actors in the grid each tick and answers an
 * invoke with the latest count as JSON — the smallest possible "server
 * authority" a client (or a CLIENT mod) can ask for.
 */
const BEACON = `use crowdy_compute_sdk::api;
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

static LAST_COUNT: AtomicU32 = AtomicU32::new(0);

fn on_init() {}

fn on_tick(_dt: u32) {
    // The grid this module is bound to: chunk coordinates come from your claim.
    // Replace with your grid's low corner, or read it from a model property.
    let (x, y, z) = (0i64, 0i64, 0i64);
    let actors = api::actors_list(x, y, z).unwrap_or_else(|_| json!({ "actors": [] }));
    let count = actors.get("actors").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
    LAST_COUNT.store(count as u32, Ordering::Relaxed);
}

fn on_invoke(_payload: &[u8]) -> Vec<u8> {
    json!({ "present": LAST_COUNT.load(Ordering::Relaxed) }).to_string().into_bytes()
}

crowdy_compute_sdk::register_module!(init: on_init, tick: on_tick, invoke: on_invoke);
`;

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
      { path: 'Cargo.toml', content: cargo('construct-hud-greeter', SERDE_JSON_DEP) },
      { path: 'src/lib.rs', content: HUD_GREETER },
    ],
  },
  {
    id: 'construct-beacon',
    title: 'Presence beacon',
    target: 'SERVER',
    description:
      'A server module that counts actors in your grid each tick and answers an invoke with the count. ' +
      'Start here for SERVER mods.',
    files: [
      { path: 'Cargo.toml', content: cargo('construct-beacon', SERDE_JSON_DEP) },
      { path: 'src/lib.rs', content: BEACON },
    ],
  },
];

/**
 * The common-file form of a template, ready for `crowdyStudioCommonPublish`.
 *
 * Two entries per template: the entrypoint AND its Cargo.toml. The Studio's
 * blank project declares only `crowdy-compute-sdk`, and `host_call` takes a
 * `serde_json::Value`, so any template that builds JSON needs the `serde_json`
 * dependency declared — measured on 2026-09-07 as `E0432: unresolved import
 * serde_json` when only the entrypoint was imported. Players add both files;
 * each import defaults to the right destination path.
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
      description: `Cargo.toml for "${template.title}": declares serde_json beside the compute SDK.`,
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
