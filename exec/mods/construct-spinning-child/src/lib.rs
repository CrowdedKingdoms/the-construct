//! Spinning child: a post in the middle of the mod's grid with an arm that swings round it, a
//! quarter turn a second while someone stands in that chunk. It is built from voxels, so every
//! player who can see the grid sees it, whether or not they run a CLIENT mod.
//!
//! The legacy SERVER template drew a box and its spinning child as a construct.scene.v1 scene,
//! sent as realtime server events. A mod sends no realtime events, so this one writes voxels
//! (`world.set_voxels`, which needs `update_voxel_data` on the grid, as a claim gives its owner):
//! whole blocks instead of a smooth rotation, and the blocks stay in the chunk when the mod stops.
//!
//! Endpoints: `state`.

use ckx_sdk::prelude::*;

const STEP_MS: u64 = 1_000;
/// Look again at who is here every this many steps: world events can be lost.
const LOOK_EVERY: u64 = 10;
/// Voxel types from the holodeck's palette.
const AIR: u16 = 0;
const WOOD: u16 = 2;
const WHITE: u16 = 3;
const PINK: u16 = 5;
/// The post's foot and the hub the arm turns round, within the grid's low chunk.
const POST: (i16, i16, i16) = (8, 0, 8);
const HUB: (i16, i16, i16) = (8, 1, 8);

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Spinner {
    pub grid: u64,
    /// The grid's low chunk, read once.
    pub origin: Option<[i64; 3]>,
    pub step: u64,
    pub ticks: u64,
    /// Actors in the low chunk when last looked; looked at again after a restart.
    #[serde(skip_deserializing)]
    pub present: usize,
    /// Whether this run has drawn the whole spinner yet.
    #[serde(skip_deserializing)]
    pub drawn: bool,
}

/// Where the arm is at `step`: beside the hub, a quarter turn further each step.
pub fn arm(step: u64) -> (i16, i16, i16) {
    let (x, y, z) = HUB;
    match step % 4 {
        0 => (x + 1, y, z),
        1 => (x, y, z + 1),
        2 => (x - 1, y, z),
        _ => (x, y, z - 1),
    }
}

/// The writes that put the arm at `step`: on a run's first step the whole spinner (the post, the
/// hub and every place the arm can be, so nothing is left over from an earlier run), then only the
/// arm's last place and its new one.
pub fn writes(origin: ChunkPos, step: u64, drawn: bool) -> Vec<VoxelWrite> {
    let put = |voxel, voxel_type| VoxelWrite { chunk: origin, voxel, voxel_type, state: None };
    if drawn {
        return vec![put(arm(step + 3), AIR), put(arm(step), PINK)];
    }
    let mut all = vec![put(POST, WOOD), put(HUB, WHITE)];
    all.extend((0..4).map(|turn| put(arm(turn), if turn == step % 4 { PINK } else { AIR })));
    all
}

impl Spinner {
    fn origin(&mut self, ctx: &Ctx) -> Result<ChunkPos> {
        let [x, y, z] = match self.origin {
            Some(origin) => origin,
            None => {
                let grid = ctx.grids().get(self.grid)?.ok_or("this mod's grid is gone")?;
                *self.origin.insert([grid.low.x, grid.low.y, grid.low.z])
            }
        };
        Ok(ChunkPos::new(x, y, z))
    }

    fn look(&mut self, ctx: &Ctx) -> Result<()> {
        let origin = self.origin(ctx)?;
        self.present = ctx.world().actors(origin)?.len();
        Ok(())
    }

    fn step(&mut self, ctx: &Ctx) -> Result<()> {
        self.ticks += 1;
        if self.ticks.is_multiple_of(LOOK_EVERY) {
            self.look(ctx)?;
        }
        if self.present == 0 {
            return Ok(());
        }
        let next = self.step + 1;
        ctx.world().set_voxels(&writes(self.origin(ctx)?, next, self.drawn))?;
        (self.step, self.drawn) = (next, true);
        Ok(())
    }
}

impl Hub for Spinner {
    fn spawn(ctx: &Ctx, _seed: &[u8]) -> Result<Self> {
        let grid = ctx.key.parse().map_err(|_| Error::new("a mod's key is its grid id"))?;
        ctx.timer_every("step", STEP_MS)?;
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
            "state" => encode(&*self),
            other => Err(Error::unknown_method(other)),
        }
    }

    fn on_timer(&mut self, ctx: &Ctx, _timer: &str) -> Result<()> {
        self.step(ctx)
    }

    fn on_world(&mut self, ctx: &Ctx, events: &[WorldEvent]) -> Result<()> {
        let origin = self.origin(ctx)?;
        if events.iter().any(|e| e.kind == WorldEvent::ACTORS && e.chunk == [origin.x, origin.y, origin.z]) {
            self.look(ctx)?;
        }
        Ok(())
    }
}

ckx_sdk::export_hub!(Spinner);

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: ChunkPos = ChunkPos::new(3, 0, -2);

    fn ctx() -> Ctx {
        Ctx { app: 7171, instance: 1, epoch: 1, version: 1, kind: Kind::Hub, node_type: "mod:spinner".into(), key: "5".into() }
    }

    fn placed(writes: &[VoxelWrite]) -> Vec<((i16, i16, i16), u16)> {
        writes.iter().map(|w| (w.voxel, w.voxel_type)).collect()
    }

    #[test]
    fn the_arm_goes_round_the_hub_a_quarter_turn_a_step() {
        let places: Vec<_> = (0..4).map(arm).collect();
        assert_eq!(places, [(9, 1, 8), (8, 1, 9), (7, 1, 8), (8, 1, 7)]);
        assert_eq!(arm(4), arm(0));
    }

    #[test]
    fn a_run_draws_everything_once_then_moves_only_the_arm() {
        let first = writes(ORIGIN, 1, false);
        assert!(first.iter().all(|w| w.chunk == ORIGIN && w.state.is_none()));
        assert_eq!(placed(&first), [(POST, WOOD), (HUB, WHITE), (arm(0), AIR), (arm(1), PINK), (arm(2), AIR), (arm(3), AIR)]);
        assert_eq!(placed(&writes(ORIGIN, 2, true)), [(arm(1), AIR), (arm(2), PINK)]);
        assert_eq!(placed(&writes(ORIGIN, 4, true)), [(arm(3), AIR), (arm(0), PINK)], "round again");
        assert!(first.len() <= ckx_sdk::node::MAX_VOXEL_WRITES);
    }

    #[test]
    fn it_only_turns_while_someone_is_here() {
        let mut s = Spinner { grid: 5, origin: Some([3, 0, -2]), ..Spinner::default() };
        s.on_timer(&ctx(), "step").unwrap();
        assert_eq!((s.ticks, s.step), (1, 0), "nobody here: no writes, no node API");
        s.present = 1;
        // Outside a host the node API answers nothing, so the write fails and the arm stays put.
        assert!(s.on_timer(&ctx(), "step").is_err());
        assert_eq!((s.step, s.drawn), (0, false));
        let elsewhere = WorldEvent { grid: 5, kind: WorldEvent::ACTORS.into(), chunk: [9, 9, 9] };
        s.on_world(&ctx(), &[elsewhere]).unwrap();
        let here = WorldEvent { grid: 5, kind: WorldEvent::ACTORS.into(), chunk: [3, 0, -2] };
        assert!(s.on_world(&ctx(), &[here]).is_err(), "an arrival here looks again");
    }

    #[test]
    fn a_restart_looks_again_and_redraws() {
        let s = Spinner { grid: 5, origin: Some([3, 0, -2]), step: 7, ticks: 70, present: 2, drawn: true };
        let state: Spinner = decode(&encode(&s).unwrap()).unwrap();
        assert_eq!((state.step, state.present, state.drawn), (7, 0, false));
        assert!(Spinner::spawn(&Ctx { key: "no".into(), ..ctx() }, &[]).is_err());
        assert_eq!(Spinner::spawn(&ctx(), &[]).unwrap().grid, 5);
    }
}
