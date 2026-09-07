import type { KitBlueprint } from '@crowdedkingdoms/crowdyjs';

export interface ProgramCatalogEntry {
  programId: number;
  sceneId: string;
  name: string;
  description: string;
}

export const PROGRAM_CATALOG: readonly ProgramCatalogEntry[];
export const PULSE_INTERVAL_MS: number;
export function constructWorldBlueprint(): KitBlueprint;
export function constructBlueprints(): KitBlueprint[];
export const KIT_PREFIXES: { progression: string; leaderboards: string };
export function kitOptions(): { progression: { typePrefix: string }; leaderboards: { typePrefix: string } };
export const MODEL_NAMES: {
  programType: string;
  worldStateType: string;
  claimType: string;
  progressType: string;
  leaderboardEntryType: string;
  pulseAutomation: string;
};
