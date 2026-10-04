//! The Construct on ck-exec. The `world` hub (key `main`) is the game's server: once a minute
//! while players are in the app it counts a pulse, and it serves the holodeck's program catalog,
//! the registry of which chunk became which player's grid, and each player's progression. It
//! replaces the legacy Game Model (`WorldState`, `Program`, `Claim`, `ConstructProgress`) and the
//! `construct-pulse` automation. The root `construct` hub only answers `status`; players poll the
//! world hub, never the root, which is rate limited.
//!
//! Endpoints on `world`: `status`, `world`, `programs` and `claims` (anyone); `progress`,
//! `record_claim` and `release_claim` (players); `forget_claim` (developers). Replies are maps
//! with camelCase keys; a refusal is an error, which the caller receives as `AppError`. Every
//! pulse is also published on the `pulse` topic.

pub mod catalog;
pub mod world;

use ckx_sdk::prelude::*;
use serde::de::DeserializeOwned;

pub use world::World;
use world::{ByGrid, ClaimsQuery, Programs, RecordClaim};

pub const WORLD_TYPE: &str = "world";
pub const WORLD_KEY: &str = "main";
/// The legacy automation's interval.
pub const PULSE_EVERY_MS: u64 = 60_000;
const PULSE_TIMER: &str = "pulse";
pub const PULSE_TOPIC: &str = "pulse";

#[derive(Serialize, Deserialize)]
pub enum Construct {
    Root,
    World(World),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootStatus {
    ok: bool,
    world_type: &'static str,
    world_key: &'static str,
}

#[derive(Serialize)]
struct Released {
    released: bool,
}

#[derive(Serialize)]
struct Forgotten {
    forgotten: bool,
}

/// Arguments a method may go without: none, `nil` or a map.
fn optional<T: DeserializeOwned + Default>(call: &Call<'_>) -> Result<T> {
    if call.payload.is_empty() {
        return Ok(T::default());
    }
    Ok(call.decode::<Option<T>>()?.unwrap_or_default())
}

/// Arguments a method needs.
fn required<T: DeserializeOwned>(call: &Call<'_>, shape: &str) -> Result<T> {
    let missing = || Error::new(format!("`{}` takes {shape}", call.method));
    if call.payload.is_empty() {
        return Err(missing());
    }
    call.decode::<Option<T>>()?.ok_or_else(missing)
}

impl Construct {
    fn world(ctx: &Ctx, world: &mut World, call: Call<'_>) -> Result<Vec<u8>> {
        let now = ctx.now_ms();
        match call.method {
            "status" => encode(&world.status(WORLD_KEY)),
            "world" => encode(&world.pulse_view(PULSE_EVERY_MS)),
            "programs" => encode(&Programs { programs: catalog::PROGRAMS }),
            "claims" => encode(&world.claims(&optional::<ClaimsQuery>(&call)?, call.player().ok())?),
            "record_claim" => {
                let owner = call.player()?;
                let req: RecordClaim = required(&call, "{ gridId, chunk: { x, y, z }, ownerName }")?;
                let recorded = world.record_claim(owner, req, now)?;
                if recorded.recorded {
                    ctx.persist_now();
                }
                encode(&recorded)
            }
            "release_claim" => {
                let caller = call.player()?;
                let req: ByGrid = required(&call, "{ gridId }")?;
                let released = world.release_claim(caller, &req.grid_id)?;
                if released {
                    ctx.persist_now();
                }
                encode(&Released { released })
            }
            "forget_claim" => {
                let by = call.developer()?;
                let req: ByGrid = required(&call, "{ gridId }")?;
                let forgotten = world.forget_claim(&req.grid_id);
                if forgotten {
                    ctx.log(Level::Info, &format!("the claim on grid {} was forgotten by developer {by}", req.grid_id.0));
                    ctx.persist_now();
                }
                encode(&Forgotten { forgotten })
            }
            "progress" => {
                let (progress, created) = world.progress(call.player()?);
                if created {
                    ctx.persist_now();
                }
                encode(&progress)
            }
            other => Err(Error::unknown_method(other)),
        }
    }
}

impl Hub for Construct {
    fn spawn(ctx: &Ctx, _seed: &[u8]) -> Result<Self> {
        if ctx.node_type != WORLD_TYPE {
            return Ok(Construct::Root);
        }
        // One world: a second key would count its own pulses and keep its own registry.
        if ctx.key != WORLD_KEY {
            return Err(Error::new(format!("there is one world, `{WORLD_KEY}`")));
        }
        ctx.timer_every(PULSE_TIMER, PULSE_EVERY_MS)?;
        Ok(Construct::World(World::default()))
    }

    fn load(ctx: &Ctx, snapshot: &[u8], _from_version: u64) -> Result<Self> {
        let hub: Construct = decode(snapshot)?;
        // Re-armed on every start, so a world that was stopped never makes up the pulses it
        // missed (the automation's rule) and the period is always this build's.
        if matches!(hub, Construct::World(_)) {
            ctx.timer_every(PULSE_TIMER, PULSE_EVERY_MS)?;
        }
        Ok(hub)
    }

    fn persist(&mut self, _ctx: &Ctx) -> Result<Vec<u8>> {
        encode(self)
    }

    fn handle(&mut self, ctx: &Ctx, call: Call<'_>) -> Result<Vec<u8>> {
        match self {
            Construct::World(world) => Self::world(ctx, world, call),
            Construct::Root => match call.method {
                "status" => encode(&RootStatus { ok: true, world_type: WORLD_TYPE, world_key: WORLD_KEY }),
                other => Err(Error::unknown_method(other)),
            },
        }
    }

    fn on_timer(&mut self, ctx: &Ctx, timer: &str) -> Result<()> {
        if let (Construct::World(world), PULSE_TIMER) = (self, timer) {
            let pulse = world.pulse(ctx.now_ms(), PULSE_EVERY_MS);
            ctx.publish(PULSE_TOPIC, &encode(&pulse)?);
        }
        Ok(())
    }
}

ckx_sdk::export_hub!(Construct);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn ctx(node_type: &str, key: &str) -> Ctx {
        Ctx { app: 7171, instance: 1, epoch: 1, version: 1, kind: Kind::Hub, node_type: node_type.into(), key: key.into() }
    }

    fn world() -> Construct {
        Construct::World(World::default())
    }

    /// Calls `method` as `caller` with `args` sent as MessagePack, and decodes the reply.
    fn call(hub: &mut Construct, caller: Caller, method: &str, args: Value) -> Result<Value> {
        let payload = encode(&args)?;
        let reply = hub.handle(&ctx(WORLD_TYPE, WORLD_KEY), Call { caller, method, payload: &payload })?;
        decode(&reply)
    }

    const NEO: Caller = Caller::Player(42);
    const SMITH: Caller = Caller::Player(43);

    #[test]
    fn claims_record_list_and_release_with_the_owner_check() {
        let mut hub = world();
        let chunk = json!({ "x": 3, "y": 0, "z": -2 });
        let recorded =
            call(&mut hub, NEO, "record_claim", json!({ "gridId": "91159989710848", "chunk": chunk, "ownerName": "neo" })).unwrap();
        assert_eq!(recorded["recorded"], json!(true));
        assert_eq!(recorded["claim"]["ownerUserId"], json!("42"), "the caller, not a client-named owner");
        assert_eq!(recorded["claim"]["gridId"], json!("91159989710848"));

        let at = call(&mut hub, SMITH, "claims", json!({ "chunk": chunk })).unwrap();
        assert_eq!(at["claims"][0]["ownerName"], json!("neo"));
        assert_eq!(at["total"], json!(1));
        assert_eq!(call(&mut hub, SMITH, "claims", Value::Null).unwrap()["claims"].as_array().map(Vec::len), Some(1));

        let refused = call(&mut hub, SMITH, "release_claim", json!({ "gridId": "91159989710848" })).unwrap_err();
        assert_eq!(refused.0, "only the claim's owner may release it");
        assert_eq!(call(&mut hub, NEO, "release_claim", json!({ "gridId": 91159989710848u64 })).unwrap(), json!({ "released": true }));
        assert_eq!(call(&mut hub, NEO, "claims", json!({ "mine": true })).unwrap()["claims"], json!([]));
    }

    #[test]
    fn who_may_call_what() {
        let mut hub = world();
        let dev = Caller::Developer(7);
        let grid = json!({ "gridId": "5" });
        assert!(call(&mut hub, dev, "record_claim", json!({ "gridId": "5", "chunk": { "x": 0, "y": 0, "z": 0 } })).is_err());
        assert!(call(&mut hub, dev, "progress", Value::Null).is_err());
        assert!(call(&mut hub, NEO, "forget_claim", grid.clone()).is_err());
        call(&mut hub, NEO, "record_claim", json!({ "gridId": "5", "chunk": { "x": 0, "y": 0, "z": 0 } })).unwrap();
        assert_eq!(call(&mut hub, dev, "forget_claim", grid).unwrap(), json!({ "forgotten": true }));
        assert!(call(&mut hub, dev, "claims", json!({ "mine": true })).is_err(), "`mine` is a player's");
        assert_eq!(call(&mut hub, dev, "status", Value::Null).unwrap()["claims"], json!(0));
    }

    #[test]
    fn missing_arguments_are_refused_by_name() {
        let mut hub = world();
        let err = call(&mut hub, NEO, "release_claim", Value::Null).unwrap_err();
        assert_eq!(err.0, "`release_claim` takes { gridId }");
        assert!(call(&mut hub, NEO, "record_claim", json!({ "gridId": "5" })).is_err(), "no chunk");
        assert!(call(&mut hub, NEO, "nope", Value::Null).unwrap_err().0.contains("unknown method"));
    }

    #[test]
    fn programs_progress_and_the_pulse() {
        let mut hub = world();
        let programs = call(&mut hub, NEO, "programs", Value::Null).unwrap();
        assert_eq!(programs["programs"][0]["sceneId"], json!("paint"));
        assert_eq!(programs["programs"][0]["programId"], json!(1));

        let progress = call(&mut hub, NEO, "progress", Value::Null).unwrap();
        assert_eq!(progress, json!({ "player": "42", "xp": 0, "level": 1, "skillPoints": 0 }));

        let c = ctx(WORLD_TYPE, WORLD_KEY);
        hub.on_timer(&c, PULSE_TIMER).unwrap();
        hub.on_timer(&c, "something else").unwrap();
        let w = call(&mut hub, SMITH, "world", Value::Null).unwrap();
        assert_eq!((w["pulses"].clone(), w["pulseEveryMs"].clone()), (json!(1), json!(PULSE_EVERY_MS)));
        let status = call(&mut hub, SMITH, "status", Value::Null).unwrap();
        assert_eq!((status["ok"].clone(), status["players"].clone(), status["world"].clone()), (json!(true), json!(1), json!("main")));
    }

    #[test]
    fn one_world_a_root_that_answers_status_and_snapshots_that_come_back() {
        let bad = Construct::spawn(&ctx(WORLD_TYPE, "elsewhere"), &[]).err().expect("a second world is refused");
        assert_eq!(bad.0, "there is one world, `main`");

        let mut root = Construct::spawn(&ctx("construct", ""), &[]).unwrap();
        let reply: Value =
            decode(&root.handle(&ctx("construct", ""), Call { caller: NEO, method: "status", payload: &[] }).unwrap()).unwrap();
        assert_eq!(reply, json!({ "ok": true, "worldType": "world", "worldKey": "main" }));
        assert!(root.handle(&ctx("construct", ""), Call { caller: NEO, method: "claims", payload: &[] }).is_err());

        // The only test that arms timers: the SDK keeps them in one guest-wide cell.
        let c = ctx(WORLD_TYPE, WORLD_KEY);
        let mut hub = Construct::spawn(&c, &[]).unwrap();
        call(&mut hub, NEO, "record_claim", json!({ "gridId": "5", "chunk": { "x": 1, "y": 0, "z": 1 }, "ownerName": "neo" })).unwrap();
        hub.on_timer(&c, PULSE_TIMER).unwrap();
        let snapshot = hub.persist(&c).unwrap();
        let mut back = Construct::load(&c, &snapshot, 1).unwrap();
        assert_eq!(call(&mut back, SMITH, "world", Value::Null).unwrap()["pulses"], json!(1));
        assert_eq!(call(&mut back, SMITH, "claims", Value::Null).unwrap()["claims"][0]["ownerName"], json!("neo"));
        let root_back = Construct::load(&ctx("construct", ""), &root.persist(&ctx("construct", "")).unwrap(), 1).unwrap();
        assert!(matches!(root_back, Construct::Root));
    }
}
