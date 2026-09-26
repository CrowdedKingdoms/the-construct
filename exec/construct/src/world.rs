//! What the world hub keeps, as the legacy Game Model's containers did: the pulse count
//! (`WorldState`), the claim registry (`Claim`) and each player's progression
//! (`ConstructProgress`). The program catalog (`Program`) is compiled in ([`crate::catalog`]).
//!
//! The claim registry exists because the platform tells a player which grid covers a chunk only
//! if the player is an app admin (`nearbyGridPermissions` needs `manage_apps`), so the game keeps
//! its own player-readable record of who claimed which chunk. A claim is recorded for the calling
//! player, never for an owner the client names, and only its owner may release it.

use std::collections::BTreeMap;

use ckx_sdk::{Error, Result};
use serde::{Deserialize, Deserializer, Serialize};

use crate::catalog::PROGRAMS;

/// Claims one player may keep in the registry.
pub const CLAIMS_PER_PLAYER: usize = 64;
/// Claims the registry keeps in all.
pub const MAX_CLAIMS: usize = 10_000;
/// The most claims a `claims` reply lists unless asked for more, as the legacy read did.
pub const LIST_DEFAULT: usize = 200;
pub const LIST_MAX: usize = 1_000;
/// An owner's name is shown over their claim; the legacy registry kept 32 characters.
const OWNER_NAME_CHARS: usize = 32;

/// A program the holodeck offers: a pad players step on to load a scene.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// The byte every pose carries; 0 is the holodeck itself.
    pub program_id: u8,
    pub scene_id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chunk {
    pub x: i64,
    pub y: i64,
    pub z: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub chunk: Chunk,
    /// The player who recorded it: the caller the platform named, not a client's word.
    pub owner: u64,
    pub owner_name: String,
    pub claimed_at: u64,
}

/// A player's progression, as the kit's `ConstructProgress` started it. Nothing grants XP yet;
/// the record is created the first time the player reads it.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub xp: i64,
    pub level: i64,
    pub skill_points: i64,
}

impl Default for Progress {
    fn default() -> Self {
        Self { xp: 0, level: 1, skill_points: 0 }
    }
}

#[derive(Serialize, Deserialize, Debug, Default, PartialEq)]
pub struct World {
    pub pulses: u64,
    pub last_pulse_at: u64,
    /// By grid id.
    pub claims: BTreeMap<String, Claim>,
    /// By the player's user id.
    pub progress: BTreeMap<u64, Progress>,
}

/// A grid id as the client sends it, a decimal string or an integer; kept as its decimal string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridId(pub String);

impl<'de> Deserialize<'de> for GridId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Int(u64),
            Text(String),
        }
        let id = match Raw::deserialize(d)? {
            Raw::Int(n) => Some(n),
            Raw::Text(s) => s.trim().parse::<u64>().ok(),
        };
        match id {
            Some(n) if n > 0 => Ok(GridId(n.to_string())),
            _ => Err(serde::de::Error::custom("a grid id is a positive integer")),
        }
    }
}

// ---- what callers send ----

/// `claims`: every claim, or only the one at `chunk`, or only the caller's (`mine`).
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaimsQuery {
    pub chunk: Option<Chunk>,
    pub mine: bool,
    pub limit: Option<usize>,
}

/// `record_claim`: the grid a claim became and the chunk it was claimed at.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordClaim {
    pub grid_id: GridId,
    pub chunk: Chunk,
    #[serde(default)]
    pub owner_name: String,
}

/// `release_claim` and `forget_claim`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ByGrid {
    pub grid_id: GridId,
}

// ---- what the hub answers ----

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pulse {
    pub pulses: u64,
    pub last_pulse_at: u64,
    pub pulse_every_ms: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ok: bool,
    pub world: &'static str,
    pub pulses: u64,
    pub programs: usize,
    pub claims: usize,
    pub players: usize,
}

#[derive(Serialize, Debug)]
pub struct Programs {
    pub programs: &'static [Program],
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    pub grid_id: String,
    pub chunk: Chunk,
    pub owner_user_id: String,
    pub owner_name: String,
    pub claimed_at: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimList {
    pub claims: Vec<ClaimView>,
    /// Claims in the registry, listed or not.
    pub total: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Recorded {
    /// False when the caller had already recorded this grid.
    pub recorded: bool,
    pub claim: ClaimView,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressView {
    pub player: String,
    pub xp: i64,
    pub level: i64,
    pub skill_points: i64,
}

fn view(grid_id: &str, claim: &Claim) -> ClaimView {
    ClaimView {
        grid_id: grid_id.to_owned(),
        chunk: claim.chunk,
        owner_user_id: claim.owner.to_string(),
        owner_name: claim.owner_name.clone(),
        claimed_at: claim.claimed_at,
    }
}

/// What is shown over a claim: printable, trimmed, at most 32 characters.
fn owner_name(raw: &str) -> String {
    let name: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(OWNER_NAME_CHARS).collect();
    if name.is_empty() { "player".to_owned() } else { name }
}

impl World {
    /// One pulse of the world's clock, from the hub's minute timer.
    pub fn pulse(&mut self, now: u64, every_ms: u64) -> Pulse {
        self.pulses += 1;
        self.last_pulse_at = now;
        self.pulse_view(every_ms)
    }

    pub fn pulse_view(&self, every_ms: u64) -> Pulse {
        Pulse { pulses: self.pulses, last_pulse_at: self.last_pulse_at, pulse_every_ms: every_ms }
    }

    pub fn status(&self, world: &'static str) -> Status {
        Status { ok: true, world, pulses: self.pulses, programs: PROGRAMS.len(), claims: self.claims.len(), players: self.progress.len() }
    }

    /// The registry as anyone may read it; `mine` needs a calling player.
    pub fn claims(&self, query: &ClaimsQuery, caller: Option<u64>) -> Result<ClaimList> {
        let mine = match (query.mine, caller) {
            (false, _) => None,
            (true, Some(player)) => Some(player),
            (true, None) => return Err(Error::new("`mine` lists a calling player's claims")),
        };
        let limit = query.limit.unwrap_or(LIST_DEFAULT).min(LIST_MAX);
        let claims = self
            .claims
            .iter()
            .filter(|(_, c)| query.chunk.is_none_or(|at| c.chunk == at))
            .filter(|(_, c)| mine.is_none_or(|p| c.owner == p))
            .take(limit)
            .map(|(grid, c)| view(grid, c))
            .collect();
        Ok(ClaimList { claims, total: self.claims.len() })
    }

    /// Records that `owner` claimed `req.chunk` and it became grid `req.grid_id`. Recording the
    /// same grid again is a no-op for its owner and refused for anyone else, and so is a chunk
    /// another player's claim already covers. A player's own earlier grid at the chunk (released
    /// and claimed again) gives way to the new one.
    pub fn record_claim(&mut self, owner: u64, req: RecordClaim, now: u64) -> Result<Recorded> {
        let grid = req.grid_id.0;
        if let Some(existing) = self.claims.get(&grid) {
            if existing.owner != owner {
                return Err(Error::new(format!("grid {grid} is recorded for another player")));
            }
            return Ok(Recorded { recorded: false, claim: view(&grid, existing) });
        }
        let at = req.chunk;
        if let Some((other, _)) = self.claims.iter().find(|(_, c)| c.chunk == at && c.owner != owner) {
            return Err(Error::new(format!("chunk {},{},{} is recorded for grid {other}, another player's", at.x, at.y, at.z)));
        }
        self.claims.retain(|_, c| !(c.chunk == at && c.owner == owner));
        if self.claims.values().filter(|c| c.owner == owner).count() >= CLAIMS_PER_PLAYER {
            return Err(Error::new(format!("a player keeps at most {CLAIMS_PER_PLAYER} claims in the registry")));
        }
        if self.claims.len() >= MAX_CLAIMS {
            return Err(Error::new("the claim registry is full"));
        }
        let claim = Claim { chunk: at, owner, owner_name: owner_name(&req.owner_name), claimed_at: now };
        let recorded = Recorded { recorded: true, claim: view(&grid, &claim) };
        self.claims.insert(grid, claim);
        Ok(recorded)
    }

    /// Removes the caller's claim on a grid. Returns false when there is none.
    pub fn release_claim(&mut self, caller: u64, grid: &GridId) -> Result<bool> {
        match self.claims.get(&grid.0) {
            None => Ok(false),
            Some(c) if c.owner != caller => Err(Error::new("only the claim's owner may release it")),
            Some(_) => Ok(self.claims.remove(&grid.0).is_some()),
        }
    }

    /// Removes anyone's claim on a grid: the developers' way to clear a row that should not be
    /// there.
    pub fn forget_claim(&mut self, grid: &GridId) -> bool {
        self.claims.remove(&grid.0).is_some()
    }

    /// The player's progression, created on first read. Also says whether it was just created.
    pub fn progress(&mut self, player: u64) -> (ProgressView, bool) {
        let created = !self.progress.contains_key(&player);
        let p = *self.progress.entry(player).or_default();
        (ProgressView { player: player.to_string(), xp: p.xp, level: p.level, skill_points: p.skill_points }, created)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: Chunk = Chunk { x: 3, y: 0, z: -2 };

    fn record(grid: &str, chunk: Chunk, name: &str) -> RecordClaim {
        RecordClaim { grid_id: GridId(grid.into()), chunk, owner_name: name.into() }
    }

    #[test]
    fn a_claim_is_its_callers_and_recording_it_again_changes_nothing() {
        let mut w = World::default();
        let first = w.record_claim(42, record("91159989710848", AT, "neo"), 1_000).unwrap();
        assert!(first.recorded);
        assert_eq!(first.claim.owner_user_id, "42");
        assert_eq!(first.claim.chunk, AT);
        let again = w.record_claim(42, record("91159989710848", AT, "someone else"), 2_000).unwrap();
        assert!(!again.recorded);
        assert_eq!((again.claim.owner_name.as_str(), again.claim.claimed_at), ("neo", 1_000));
        assert_eq!(w.claims.len(), 1);
    }

    #[test]
    fn another_players_grid_or_chunk_is_refused() {
        let mut w = World::default();
        w.record_claim(42, record("7", AT, "neo"), 0).unwrap();
        let grid = w.record_claim(43, record("7", AT, "smith"), 0).unwrap_err();
        assert!(grid.0.contains("another player"), "{grid}");
        let chunk = w.record_claim(43, record("8", AT, "smith"), 0).unwrap_err();
        assert!(chunk.0.contains("chunk 3,0,-2"), "{chunk}");
        assert_eq!(w.claims["7"].owner, 42);
    }

    #[test]
    fn a_players_new_grid_at_their_chunk_replaces_the_old_one() {
        let mut w = World::default();
        w.record_claim(42, record("7", AT, "neo"), 0).unwrap();
        w.record_claim(42, record("9", AT, "neo"), 5).unwrap();
        assert_eq!(w.claims.keys().collect::<Vec<_>>(), ["9"]);
    }

    #[test]
    fn only_the_owner_releases_and_developers_forget_anyones() {
        let mut w = World::default();
        w.record_claim(42, record("7", AT, "neo"), 0).unwrap();
        let refused = w.release_claim(43, &GridId("7".into())).unwrap_err();
        assert_eq!(refused.0, "only the claim's owner may release it");
        assert!(w.release_claim(42, &GridId("7".into())).unwrap());
        assert!(!w.release_claim(42, &GridId("7".into())).unwrap(), "released twice");
        w.record_claim(42, record("7", AT, "neo"), 0).unwrap();
        assert!(w.forget_claim(&GridId("7".into())));
        assert!(w.claims.is_empty());
    }

    #[test]
    fn the_registry_lists_by_chunk_by_owner_and_within_a_limit() {
        let mut w = World::default();
        for n in 0..5 {
            w.record_claim(42 + n % 2, record(&(100 + n).to_string(), Chunk { x: n as i64, y: 0, z: 0 }, "p"), 0).unwrap();
        }
        let at = w.claims(&ClaimsQuery { chunk: Some(Chunk { x: 2, y: 0, z: 0 }), ..Default::default() }, None).unwrap();
        assert_eq!(at.claims.iter().map(|c| c.grid_id.as_str()).collect::<Vec<_>>(), ["102"]);
        assert_eq!(at.total, 5);
        let mine = w.claims(&ClaimsQuery { mine: true, ..Default::default() }, Some(43)).unwrap();
        assert_eq!(mine.claims.len(), 2);
        assert!(w.claims(&ClaimsQuery { mine: true, ..Default::default() }, None).is_err());
        let two = w.claims(&ClaimsQuery { limit: Some(2), ..Default::default() }, None).unwrap();
        assert_eq!(two.claims.len(), 2);
        let capped = w.claims(&ClaimsQuery { limit: Some(1_000_000), ..Default::default() }, None).unwrap();
        assert_eq!(capped.claims.len(), 5);
    }

    #[test]
    fn a_player_keeps_a_bounded_number_of_claims() {
        let mut w = World::default();
        for n in 0..CLAIMS_PER_PLAYER as i64 {
            w.record_claim(42, record(&(n + 1).to_string(), Chunk { x: n, y: 0, z: 0 }, "p"), 0).unwrap();
        }
        let over = w.record_claim(42, record("999999", Chunk { x: -1, y: 0, z: 0 }, "p"), 0).unwrap_err();
        assert!(over.0.contains("at most"), "{over}");
        w.record_claim(43, record("999999", Chunk { x: -1, y: 0, z: 0 }, "p"), 0).unwrap();
    }

    #[test]
    fn owner_names_are_printable_trimmed_and_short() {
        assert_eq!(owner_name("  neo\u{7}\n "), "neo");
        assert_eq!(owner_name(""), "player");
        assert_eq!(owner_name(&"é".repeat(40)).chars().count(), OWNER_NAME_CHARS);
    }

    #[test]
    fn progression_starts_at_level_one_on_first_read() {
        let mut w = World::default();
        let (first, created) = w.progress(42);
        assert!(created);
        assert_eq!((first.player.as_str(), first.xp, first.level, first.skill_points), ("42", 0, 1, 0));
        let (_, again) = w.progress(42);
        assert!(!again);
        assert_eq!(w.status("main").players, 1);
    }

    #[test]
    fn pulses_count_up() {
        let mut w = World::default();
        assert_eq!(w.pulse(10, 60_000), Pulse { pulses: 1, last_pulse_at: 10, pulse_every_ms: 60_000 });
        assert_eq!(w.pulse(20, 60_000).pulses, 2);
        assert_eq!(w.pulse_view(60_000).last_pulse_at, 20);
    }

    #[test]
    fn grid_ids_arrive_as_strings_or_integers() {
        let text: ByGrid = ckx_sdk::decode(&ckx_sdk::encode(&serde_json::json!({ "gridId": " 0091159989710848 " })).unwrap()).unwrap();
        assert_eq!(text.grid_id, GridId("91159989710848".into()));
        let int: ByGrid = ckx_sdk::decode(&ckx_sdk::encode(&serde_json::json!({ "gridId": 7 })).unwrap()).unwrap();
        assert_eq!(int.grid_id, GridId("7".into()));
        for bad in [serde_json::json!({ "gridId": "x" }), serde_json::json!({ "gridId": 0 }), serde_json::json!({ "gridId": -3 })] {
            assert!(ckx_sdk::decode::<ByGrid>(&ckx_sdk::encode(&bad).unwrap()).is_err(), "{bad}");
        }
    }
}
