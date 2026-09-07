/**
 * The programs a player can load from the holodeck.
 *
 * `programId` is the byte broadcast in every pose (0 is the holodeck itself),
 * `sceneId` is what the router loads, and `pad` is where the pad stands in
 * the holodeck. The seed publishes the same list into a `Program` container on
 * the game model so server-side logic (automations, leaderboards) can refer to
 * programs by id; the client keeps this copy so it can render pads before the
 * model has been read.
 */
export interface ProgramDefinition {
  programId: number;
  sceneId: string;
  name: string;
  description: string;
  pad: { x: number; z: number };
  /** Accent colour for the pad and the HUD chip. */
  color: number;
}

export const PROGRAMS: readonly ProgramDefinition[] = [
  {
    programId: 1,
    sceneId: 'paint',
    name: 'Paint',
    description: 'A shared 2D canvas. Click to paint voxels everyone sees, live and persisted.',
    pad: { x: 10, z: -6 },
    color: 0xff7ac8,
  },
];

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
export const HOLODECK_SPAWN = { x: 0, y: 0, z: 6, yaw: Math.PI };
