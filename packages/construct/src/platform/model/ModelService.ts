/**
 * The game-state facade: what the client reads from the server that keeps the game's rules,
 * in game terms.
 *
 * That server is the app's world hub on ck-exec (the starter's `exec/construct`, deployed by
 * `npm run setup` / `npm run deploy:exec`), reached over the one connection
 * `NetworkManager.worldHub` holds. The hub decides; this class only asks, as the signed-in
 * player: it cannot grant itself XP, and it never names another player. Reads are cached
 * briefly because the HUD polls them.
 */
import type { GameSession } from '../GameSession';
import { messageOf } from '../network/NetworkManager';

export interface ProgramRecord {
  /** `program-<programId>`. */
  containerId: string;
  programId: number;
  sceneId: string;
  name: string;
  description: string;
}

export interface ProgressSummary {
  /** The progression record's id: the player's user id, on the world hub. */
  containerId: string;
  xp: number;
  level: number;
  skillPoints: number;
}

export interface WorldSummary {
  pulses: number;
  /** The world hub answered: it is deployed and reachable. */
  seeded: boolean;
}

interface HubProgram {
  programId: number;
  sceneId: string;
  name: string;
  description: string;
}

interface HubProgress {
  player: string;
  xp: number;
  level: number;
  skillPoints: number;
}

const CACHE_MS = 15_000;

export class ModelService {
  private programsCache: { at: number; value: ProgramRecord[] } | null = null;
  private worldCache: { at: number; value: WorldSummary } | null = null;
  private progressCache: { at: number; value: ProgressSummary } | null = null;

  constructor(private readonly session: GameSession) {}

  private get hub() {
    return this.session.network.worldHub;
  }

  /** The program catalog the hub serves; empty when the hub cannot be reached. */
  async programs(): Promise<ProgramRecord[]> {
    if (this.programsCache && Date.now() - this.programsCache.at < CACHE_MS)
      return this.programsCache.value;
    let value: ProgramRecord[] = [];
    try {
      const { programs } = await this.hub.call<{ programs: HubProgram[] }>('programs');
      value = programs.map((program) => ({
        containerId: `program-${program.programId}`,
        programId: Number(program.programId),
        sceneId: String(program.sceneId),
        name: String(program.name),
        description: String(program.description),
      }));
    } catch (error) {
      this.session.network.log(`program catalog unavailable: ${messageOf(error)}`);
    }
    this.programsCache = { at: Date.now(), value };
    return value;
  }

  /** The world's pulse count: proof the hub's minute timer runs while someone is here. */
  async world(): Promise<WorldSummary> {
    if (this.worldCache && Date.now() - this.worldCache.at < CACHE_MS) return this.worldCache.value;
    let value: WorldSummary = { pulses: 0, seeded: false };
    try {
      const { pulses } = await this.hub.call<{ pulses: number }>('world');
      value = { pulses: Number(pulses), seeded: true };
    } catch (error) {
      this.session.network.log(`world state unavailable: ${messageOf(error)}`);
    }
    this.worldCache = { at: Date.now(), value };
    return value;
  }

  /** The player's progression, which the hub creates on first read. */
  async progress(): Promise<ProgressSummary | null> {
    if (this.progressCache && Date.now() - this.progressCache.at < CACHE_MS)
      return this.progressCache.value;
    try {
      const progress = await this.hub.call<HubProgress>('progress');
      const value: ProgressSummary = {
        containerId: String(progress.player),
        xp: Number(progress.xp),
        level: Number(progress.level),
        skillPoints: Number(progress.skillPoints),
      };
      this.progressCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      this.session.network.log(`progression unavailable: ${messageOf(error)}`);
      return null;
    }
  }

  invalidate(): void {
    this.programsCache = null;
    this.worldCache = null;
    this.progressCache = null;
  }
}
