/**
 * The game-model facade: everything the client reads from or asks of the
 * server-authoritative model, in game terms rather than container terms.
 *
 * The model itself is defined ONCE in `model/blueprints.mjs` and deployed by
 * the Setup wizard / `npm run seed`. This class only consumes it through the
 * Game Kit runtime helpers and `client.gameModel`, with a player token — it
 * cannot create types, and it cannot grant itself XP (the blueprint says who
 * may). Reads are cached briefly because the HUD polls them.
 */
import { MODEL_NAMES, kitOptions } from '../../../model/blueprints.mjs';

import type { GameSession } from '@/platform/GameSession';
import { messageOf } from '@/platform/network/NetworkManager';

export interface ProgramRecord {
  containerId: string;
  programId: number;
  sceneId: string;
  name: string;
  description: string;
}

export interface ProgressSummary {
  containerId: string;
  xp: number;
  level: number;
  skillPoints: number;
}

export interface WorldSummary {
  pulses: number;
  /** The model has been seeded (the WorldState singleton exists). */
  seeded: boolean;
}

const CACHE_MS = 15_000;

export class ModelService {
  private programsCache: { at: number; value: ProgramRecord[] } | null = null;
  private worldCache: { at: number; value: WorldSummary } | null = null;
  private progressId: string | null = null;

  constructor(private readonly session: GameSession) {}

  private get kit() {
    return this.session.network.game.kit(this.session.appId, kitOptions());
  }

  private get gameModel() {
    return this.session.network.game.gameModel;
  }

  /** The seeded program catalog; empty when the model has not been seeded. */
  async programs(): Promise<ProgramRecord[]> {
    if (this.programsCache && Date.now() - this.programsCache.at < CACHE_MS)
      return this.programsCache.value;
    const appId = this.session.appId;
    const value: ProgramRecord[] = [];
    try {
      const containers = await this.gameModel.containers({
        appId,
        typeName: MODEL_NAMES.programType,
      });
      for (const container of containers) {
        const props = await this.properties(container.containerId);
        value.push({
          containerId: container.containerId,
          programId: Number(props.program_id ?? 0),
          sceneId: String(props.scene_id ?? ''),
          name: String(props.name ?? container.displayName),
          description: String(props.description ?? ''),
        });
      }
    } catch (error) {
      this.session.network.log(`program catalog unavailable: ${messageOf(error)}`);
    }
    this.programsCache = { at: Date.now(), value };
    return value;
  }

  /** WorldState.pulses — proof the automation runs while someone is here. */
  async world(): Promise<WorldSummary> {
    if (this.worldCache && Date.now() - this.worldCache.at < CACHE_MS) return this.worldCache.value;
    const appId = this.session.appId;
    let value: WorldSummary = { pulses: 0, seeded: false };
    try {
      const [state] = await this.gameModel.containers({
        appId,
        typeName: MODEL_NAMES.worldStateType,
      });
      if (state) {
        const props = await this.properties(state.containerId);
        value = { pulses: Number(props.pulses ?? 0), seeded: true };
      }
    } catch (error) {
      this.session.network.log(`world state unavailable: ${messageOf(error)}`);
    }
    this.worldCache = { at: Date.now(), value };
    return value;
  }

  /** The player's progression record, created on first visit. */
  async progress(): Promise<ProgressSummary | null> {
    try {
      if (!this.progressId) {
        const container = await this.kit.progression.ensure(this.session.userId, {
          displayName: `${this.session.displayName}'s progress`,
        });
        this.progressId = container.containerId;
      }
      const state = await this.kit.progression.state(this.progressId);
      return {
        containerId: state.containerId,
        xp: state.xp,
        level: state.level,
        skillPoints: state.skillPoints,
      };
    } catch (error) {
      this.session.network.log(`progression unavailable: ${messageOf(error)}`);
      return null;
    }
  }

  invalidate(): void {
    this.programsCache = null;
    this.worldCache = null;
  }

  private async properties(containerId: string): Promise<Record<string, unknown>> {
    const state = await this.gameModel.containerState({ appId: this.session.appId, containerId });
    try {
      return JSON.parse(state.propertiesJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
