//! Presence beacon: a mod that counts the players standing in its grid and answers `present` with
//! the count, the smallest piece of server authority a game (or a player) can ask a grid for.
//!
//! A mod is a player's code on a grid they own: one instance per grid, keyed by the grid id, run
//! as its owner. It reads only its own grid through the node API (`grids.get`, `world.actors`),
//! hears actors arrive and leave through `on_world`, and answers the players who call it
//! (`mod:<name>`, with the grid id as the key). It calls no other node and sends no realtime
//! events.
//!
//! Endpoints: `present` and `state`.

use ckx_sdk::prelude::*;

/// Count again this often too: world events can be lost.
const COUNT_EVERY_MS: u64 = 10_000;
/// The most chunks one count reads; a claimed chunk is a grid of one.
const MAX_CHUNKS: usize = 27;

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Beacon {
    pub grid: u64,
    /// The grid's low and high chunk, read once.
    pub bounds: Option<([i64; 3], [i64; 3])>,
    pub present: usize,
    pub counted_at: u64,
}

#[derive(Serialize)]
struct Present {
    present: usize,
}

/// The chunks of a box, x fastest, at most `max` of them.
pub fn chunks(low: [i64; 3], high: [i64; 3], max: usize) -> Vec<ChunkPos> {
    let mut out = Vec::new();
    for y in low[1]..=high[1] {
        for z in low[2]..=high[2] {
            for x in low[0]..=high[0] {
                if out.len() == max {
                    return out;
                }
                out.push(ChunkPos::new(x, y, z));
            }
        }
    }
    out
}

/// Whether a batch of world events may have changed who is here.
pub fn actors_moved(events: &[WorldEvent]) -> bool {
    events.iter().any(|e| e.kind == WorldEvent::ACTORS)
}

impl Beacon {
    fn bounds(&mut self, ctx: &Ctx) -> Result<([i64; 3], [i64; 3])> {
        if let Some(bounds) = self.bounds {
            return Ok(bounds);
        }
        let grid = ctx.grids().get(self.grid)?.ok_or("this mod's grid is gone")?;
        let bounds = ([grid.low.x, grid.low.y, grid.low.z], [grid.high.x, grid.high.y, grid.high.z]);
        self.bounds = Some(bounds);
        Ok(bounds)
    }

    fn count(&mut self, ctx: &Ctx) -> Result<()> {
        let (low, high) = self.bounds(ctx)?;
        let mut present = 0;
        for at in chunks(low, high, MAX_CHUNKS) {
            present += ctx.world().actors(at)?.len();
        }
        self.present = present;
        self.counted_at = ctx.now_ms();
        Ok(())
    }
}

impl Hub for Beacon {
    fn spawn(ctx: &Ctx, _seed: &[u8]) -> Result<Self> {
        let grid = ctx.key.parse().map_err(|_| Error::new("a mod's key is its grid id"))?;
        ctx.timer_every("count", COUNT_EVERY_MS)?;
        Ok(Self { grid, ..Self::default() })
    }

    fn load(_ctx: &Ctx, snapshot: &[u8], _from_version: u64) -> Result<Self> {
        decode(snapshot)
    }

    fn persist(&mut self, _ctx: &Ctx) -> Result<Vec<u8>> {
        encode(self)
    }

    fn handle(&mut self, _ctx: &Ctx, call: Call<'_>) -> Result<Vec<u8>> {
        match call.method {
            "present" => encode(&Present { present: self.present }),
            "state" => encode(&*self),
            other => Err(Error::unknown_method(other)),
        }
    }

    fn on_timer(&mut self, ctx: &Ctx, _timer: &str) -> Result<()> {
        self.count(ctx)
    }

    fn on_world(&mut self, ctx: &Ctx, events: &[WorldEvent]) -> Result<()> {
        if actors_moved(events) {
            self.count(ctx)?;
        }
        Ok(())
    }
}

ckx_sdk::export_hub!(Beacon);

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(key: &str) -> Ctx {
        Ctx { app: 7171, instance: 1, epoch: 1, version: 1, kind: Kind::Hub, node_type: "mod:beacon".into(), key: key.into() }
    }

    fn event(kind: &str) -> WorldEvent {
        WorldEvent { grid: 5, kind: kind.into(), chunk: [0, 0, 0] }
    }

    #[test]
    fn a_grid_is_counted_chunk_by_chunk_within_a_cap() {
        assert_eq!(chunks([4, 0, -2], [4, 0, -2], MAX_CHUNKS), vec![ChunkPos::new(4, 0, -2)]);
        let six = chunks([0, 0, 0], [2, 0, 1], MAX_CHUNKS);
        assert_eq!(six.len(), 6);
        assert_eq!((six[1], six[3]), (ChunkPos::new(1, 0, 0), ChunkPos::new(0, 0, 1)), "x fastest");
        assert_eq!(chunks([0, 0, 0], [99, 99, 99], MAX_CHUNKS).len(), MAX_CHUNKS);
    }

    #[test]
    fn only_actor_events_start_a_count() {
        assert!(!actors_moved(&[event(WorldEvent::VOXELS)]));
        assert!(actors_moved(&[event(WorldEvent::VOXELS), event(WorldEvent::ACTORS)]));
        let mut beacon = Beacon { grid: 5, present: 2, ..Beacon::default() };
        // Voxel changes do not touch the node API (which answers nothing outside a host).
        beacon.on_world(&ctx("5"), &[event(WorldEvent::VOXELS)]).unwrap();
        assert!(beacon.on_world(&ctx("5"), &[event(WorldEvent::ACTORS)]).is_err());
        assert_eq!(beacon.present, 2, "a failed count keeps the last one");
    }

    #[test]
    fn present_answers_the_last_count() {
        #[derive(Deserialize)]
        struct Reply {
            present: usize,
        }
        let mut beacon = Beacon { grid: 5, present: 3, counted_at: 9, ..Beacon::default() };
        let reply: Reply =
            decode(&beacon.handle(&ctx("5"), Call { caller: Caller::Player(42), method: "present", payload: &[] }).unwrap()).unwrap();
        assert_eq!(reply.present, 3);
        let state: Beacon =
            decode(&beacon.handle(&ctx("5"), Call { caller: Caller::Player(42), method: "state", payload: &[] }).unwrap()).unwrap();
        assert_eq!(state, beacon);
        assert!(beacon.handle(&ctx("5"), Call { caller: Caller::Player(42), method: "nope", payload: &[] }).is_err());
    }

    #[test]
    fn the_key_is_the_grid_id() {
        assert!(Beacon::spawn(&ctx("not-a-grid"), &[]).is_err());
        let beacon = Beacon::spawn(&ctx("91159989710848"), &[]).unwrap();
        assert_eq!(beacon.grid, 91_159_989_710_848);
        let mut back: Beacon = Beacon::load(&ctx("91159989710848"), &encode(&beacon).unwrap(), 1).unwrap();
        assert_eq!(back.persist(&ctx("91159989710848")).unwrap(), encode(&beacon).unwrap());
    }
}
