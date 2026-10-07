/**
 * The programs a player can load from the holodeck.
 *
 * `programId` is the byte broadcast in every pose (0 is the holodeck itself),
 * `sceneId` is what the router loads, and `pad` is where the pad stands in
 * the holodeck. Everything but the pad and its colour comes from
 * PROGRAM_CATALOG in `model/catalog.mjs`, the list the world hub serves too
 * (`npm run build:exec-sources` compiles it into the hub).
 */
import { PROGRAM_CATALOG } from '../../model/catalog.mjs';

export interface ProgramDefinition {
  programId: number;
  sceneId: string;
  name: string;
  description: string;
  pad: { x: number; z: number };
  /** Accent colour for the pad and the HUD chip. */
  color: number;
}

/** Where each program's pad stands, and its colour, by scene. */
const PADS: Record<string, Pick<ProgramDefinition, 'pad' | 'color'>> = {
  paint: { pad: { x: 10, z: -6 }, color: 0xff7ac8 },
};

export const PROGRAMS: readonly ProgramDefinition[] = PROGRAM_CATALOG.map((program) => {
  const pad = PADS[program.sceneId];
  if (!pad) throw new Error(`No pad for program "${program.sceneId}" in src/game/programs.ts`);
  return { ...program, ...pad };
});

export const HOLODECK_SCENE_ID = 'holodeck';

export function programById(programId: number): ProgramDefinition | undefined {
  return PROGRAMS.find((p) => p.programId === programId);
}

export function programBySceneId(sceneId: string): ProgramDefinition | undefined {
  return PROGRAMS.find((p) => p.sceneId === sceneId);
}

/** Where the claim pad stands: step on it and press E to claim the chunk. */
export const CLAIM_PAD = { x: -10, z: -6, color: 0x5ef2c8 };

/** Where new players appear in the holodeck. */
export const HOLODECK_SPAWN = { x: 0, y: 0, z: 6, yaw: 0 };
