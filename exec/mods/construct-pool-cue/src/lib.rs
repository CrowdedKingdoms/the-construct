//! Pool cue: a table with three balls in the middle of the mod's grid, and a cue that strokes at
//! the white ball once a second while someone stands in that chunk. It is built from voxels, so
//! passers-by who never accepted a CLIENT mod see the same table.
//!
//! The legacy SERVER template drew a felt box, sphere balls and a procedural-mesh cue as a
//! construct.scene.v1 scene, sent as realtime server events, which a mod cannot send. This one
//! builds the table once with `world.set_voxels` (at most 16 voxels a call, so in batches; it
//! needs `update_voxel_data` on the grid, as a claim gives its owner) and moves the cue in whole
//! blocks. The blocks stay in the chunk when the mod stops.
//!
//! Endpoints: `state`.

use ckx_sdk::node::MAX_VOXEL_WRITES;
use ckx_sdk::prelude::*;

const STROKE_MS: u64 = 1_000;
/// Look again at who is here every this many strokes: world events can be lost.
const LOOK_EVERY: u64 = 10;
/// Voxel types from the holodeck's palette.
const AIR: u16 = 0;
const FELT: u16 = 1;
const WOOD: u16 = 2;
const WHITE: u16 = 3;
const YELLOW: u16 = 7;
const BLACK: u16 = 12;

type Voxel = ((i16, i16, i16), u16);

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Table {
    pub grid: u64,
    /// The grid's low chunk, read once.
    pub origin: Option<[i64; 3]>,
    /// The table and balls are in the chunk; voxels outlive a restart, so this is kept.
    pub built: bool,
    pub stroke: u64,
    pub ticks: u64,
    /// Actors in the low chunk when last looked; looked at again after a restart.
    #[serde(skip_deserializing)]
    pub present: usize,
    /// Whether this run has drawn the whole cue yet.
    #[serde(skip_deserializing)]
    pub drawn: bool,
}

/// The table, within the grid's low chunk: a felt top on four wooden legs, and the white, a yellow
/// and the black ball on it.
pub fn table() -> Vec<Voxel> {
    let mut voxels: Vec<Voxel> = [(6, 7), (10, 7), (6, 9), (10, 9)].into_iter().map(|(x, z)| ((x, 0, z), WOOD)).collect();
    for x in 6..=10 {
        for z in 7..=9 {
            voxels.push(((x, 1, z), FELT));
        }
    }
    voxels.extend([((7, 2, 8), WHITE), ((9, 2, 7), YELLOW), ((9, 2, 9), BLACK)]);
    voxels
}

/// The cue at `stroke`, three places along x in line with the white ball: pulled back on even
/// strokes, its tip against the ball on odd ones.
pub fn cue(stroke: u64) -> [Voxel; 3] {
    let forward = stroke % 2 == 1;
    [((4, 2, 8), if forward { AIR } else { WOOD }), ((5, 2, 8), WOOD), ((6, 2, 8), if forward { WOOD } else { AIR })]
}

/// The batches of writes for `stroke`: the table if it is not built, the whole cue on a run's first
/// stroke, then only the cue's two ends.
pub fn batches(origin: ChunkPos, stroke: u64, built: bool, drawn: bool) -> Vec<Vec<VoxelWrite>> {
    let put = |(voxel, voxel_type): Voxel| VoxelWrite { chunk: origin, voxel, voxel_type, state: None };
    let mut all: Vec<VoxelWrite> = if built { Vec::new() } else { table().into_iter().map(put).collect() };
    let [back, middle, tip] = cue(stroke);
    if built && drawn {
        all.extend([put(back), put(tip)]);
    } else {
        all.extend([put(back), put(middle), put(tip)]);
    }
    all.chunks(MAX_VOXEL_WRITES).map(<[VoxelWrite]>::to_vec).collect()
}

impl Table {
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

    fn stroke(&mut self, ctx: &Ctx) -> Result<()> {
        self.ticks += 1;
        if self.ticks.is_multiple_of(LOOK_EVERY) {
            self.look(ctx)?;
        }
        if self.present == 0 {
            return Ok(());
        }
        let next = self.stroke + 1;
        for batch in batches(self.origin(ctx)?, next, self.built, self.drawn) {
            ctx.world().set_voxels(&batch)?;
        }
        (self.stroke, self.built, self.drawn) = (next, true, true);
        Ok(())
    }
}

impl Hub for Table {
    fn spawn(ctx: &Ctx, _seed: &[u8]) -> Result<Self> {
        let grid = ctx.key.parse().map_err(|_| Error::new("a mod's key is its grid id"))?;
        ctx.timer_every("stroke", STROKE_MS)?;
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
        self.stroke(ctx)
    }

    fn on_world(&mut self, ctx: &Ctx, events: &[WorldEvent]) -> Result<()> {
        let origin = self.origin(ctx)?;
        if events.iter().any(|e| e.kind == WorldEvent::ACTORS && e.chunk == [origin.x, origin.y, origin.z]) {
            self.look(ctx)?;
        }
        Ok(())
    }
}

ckx_sdk::export_hub!(Table);

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: ChunkPos = ChunkPos::new(3, 0, -2);

    fn ctx() -> Ctx {
        Ctx { app: 7171, instance: 1, epoch: 1, version: 1, kind: Kind::Hub, node_type: "mod:pool".into(), key: "5".into() }
    }

    fn placed(batch: &[VoxelWrite]) -> Vec<Voxel> {
        batch.iter().map(|w| (w.voxel, w.voxel_type)).collect()
    }

    #[test]
    fn the_table_is_felt_on_legs_with_three_balls() {
        let t = table();
        assert_eq!(t.len(), 22);
        assert_eq!(t.iter().filter(|(_, v)| *v == FELT).count(), 15);
        assert_eq!(t.iter().filter(|((_, y, _), v)| *v == WOOD && *y == 0).count(), 4);
        assert!(t.contains(&((7, 2, 8), WHITE)) && t.contains(&((9, 2, 9), BLACK)));
    }

    #[test]
    fn the_cue_strokes_at_the_white_ball() {
        assert_eq!(cue(0), [((4, 2, 8), WOOD), ((5, 2, 8), WOOD), ((6, 2, 8), AIR)]);
        assert_eq!(cue(1), [((4, 2, 8), AIR), ((5, 2, 8), WOOD), ((6, 2, 8), WOOD)]);
        assert_eq!(cue(2), cue(0));
    }

    #[test]
    fn a_build_fits_the_voxel_limit_and_later_strokes_move_two_blocks() {
        let build = batches(ORIGIN, 1, false, false);
        assert_eq!(build.iter().map(Vec::len).collect::<Vec<_>>(), [16, 9]);
        assert!(build.iter().flatten().all(|w| w.chunk == ORIGIN && w.state.is_none()));
        assert_eq!(placed(&batches(ORIGIN, 1, true, false)[0]), cue(1));
        assert_eq!(placed(&batches(ORIGIN, 2, true, true)[0]), [((4, 2, 8), WOOD), ((6, 2, 8), AIR)]);
    }

    #[test]
    fn it_only_strokes_while_someone_is_here() {
        let mut t = Table { grid: 5, origin: Some([3, 0, -2]), built: true, ..Table::default() };
        t.on_timer(&ctx(), "stroke").unwrap();
        assert_eq!((t.ticks, t.stroke), (1, 0));
        t.present = 1;
        assert!(t.on_timer(&ctx(), "stroke").is_err(), "outside a host the node API answers nothing");
        assert_eq!((t.stroke, t.drawn), (0, false));
        let here = WorldEvent { grid: 5, kind: WorldEvent::ACTORS.into(), chunk: [3, 0, -2] };
        assert!(t.on_world(&ctx(), &[here]).is_err());
        let voxels = WorldEvent { grid: 5, kind: WorldEvent::VOXELS.into(), chunk: [3, 0, -2] };
        t.on_world(&ctx(), &[voxels]).unwrap();
    }

    #[test]
    fn a_restart_keeps_the_table_and_redraws_the_cue() {
        let t = Table { grid: 5, origin: Some([3, 0, -2]), built: true, stroke: 3, ticks: 30, present: 1, drawn: true };
        let back: Table = decode(&encode(&t).unwrap()).unwrap();
        assert_eq!((back.built, back.stroke, back.present, back.drawn), (true, 3, 0, false));
        assert!(Table::spawn(&Ctx { key: "x".into(), ..ctx() }, &[]).is_err());
        assert_eq!(Table::spawn(&ctx(), &[]).unwrap().grid, 5);
    }
}
