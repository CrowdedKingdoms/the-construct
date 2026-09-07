/**
 * The Construct's game model, as Game Kit blueprints.
 *
 * Plain ES module (no TypeScript) on purpose: the browser Setup wizard and
 * the headless `scripts/seed.mjs` both import it, so the ONE definition of the
 * model is deployed no matter which door you come in by. Deployment is
 * `client.kit(appId).deploy(constructBlueprints())`, which is idempotent —
 * run it again after editing this file and only the differences apply.
 *
 * Three layers, chosen to show the three things almost any game needs:
 *
 *  1. `progressionBlueprint` — xp / levels / skills / achievements for each
 *     player, from the kit. Trusted grants only (`xpAuthority: 'server'`):
 *     a player cannot give themselves XP; an app admin or an automation can.
 *  2. `leaderboardsBlueprint` — keep-best score entries. `'host'` authority
 *     means the elected host client may submit — the cheapest referee for a
 *     game with no backend of its own. Upgrade to `'server'` or an automation
 *     when scores start to matter.
 *  3. The hand-authored layer below: a `Program` catalog (mirrors
 *     `src/platform/programs.ts` so server-side logic can refer to programs by
 *     id) and a `WorldState` singleton with a pulse automation.
 */
import { leaderboardsBlueprint, progressionBlueprint } from '@crowdedkingdoms/crowdyjs';

/**
 * Programs the holodeck offers. Keep in step with `src/platform/programs.ts`
 * (the client copy renders pads before the model is read).
 */
export const PROGRAM_CATALOG = [
  {
    programId: 1,
    sceneId: 'paint',
    name: 'Paint',
    description: 'A shared 2D canvas. Click to paint voxels everyone sees, live and persisted.',
  },
];

export const PULSE_INTERVAL_MS = 60_000;

/** The hand-authored blueprint: catalog + world singleton + one automation. */
export function constructWorldBlueprint() {
  return {
    name: 'construct-world',
    containerTypes: [
      {
        typeName: 'Program',
        displayName: 'Program',
        instantiableBy: 'admin',
        defaultPropertyVisibility: 'public',
        description: 'A loadable program in the holodeck. Seeded; players read it.',
      },
      {
        typeName: 'WorldState',
        displayName: 'World state',
        instantiableBy: 'admin',
        defaultPropertyVisibility: 'public',
        description: 'The single shared world record the pulse automation advances.',
      },
    ],
    propertyDefinitions: [
      { containerTypeName: 'Program', key: 'program_id', valueType: 'int', defaultValueJson: '0' },
      { containerTypeName: 'Program', key: 'scene_id', valueType: 'string', defaultValueJson: '""' },
      { containerTypeName: 'Program', key: 'name', valueType: 'string', defaultValueJson: '""' },
      { containerTypeName: 'Program', key: 'description', valueType: 'string', defaultValueJson: '""' },
      {
        containerTypeName: 'WorldState',
        key: 'pulses',
        valueType: 'int',
        defaultValueJson: '0',
        description: 'How many times the pulse automation has run while players were present.',
      },
    ],
    functions: [
      {
        name: 'construct_pulse',
        containerTypeName: 'WorldState',
        returnType: 'int',
        mutations: [{ target: 'self', property: 'pulses', expression: 'self.pulses + 1' }],
        returnExpression: 'self.pulses',
        // Automation-only: no player may call this directly.
        invokePolicyJson: JSON.stringify({ type: 'is_automation' }),
        autonomousInvocable: true,
        description:
          'Counts pulses. NOTE the platform presence rule: schedule automations run only ' +
          'while the app has at least one player connected, and missed runs are never made up. ' +
          'Model expressions have no clock, so anything that must reflect real elapsed time ' +
          'belongs in a compute module (which gets one) or in a client-supplied timestamp ' +
          'that the server validates.',
      },
    ],
    containers: [
      ...PROGRAM_CATALOG.map((program) => ({
        tempId: `program-${program.programId}`,
        typeName: 'Program',
        displayName: program.name,
        properties: [
          { key: 'program_id', valueType: 'int', valueJson: String(program.programId) },
          { key: 'scene_id', valueType: 'string', valueJson: JSON.stringify(program.sceneId) },
          { key: 'name', valueType: 'string', valueJson: JSON.stringify(program.name) },
          { key: 'description', valueType: 'string', valueJson: JSON.stringify(program.description) },
        ],
      })),
      {
        tempId: 'world-state',
        typeName: 'WorldState',
        displayName: 'The Construct',
        properties: [{ key: 'pulses', valueType: 'int', valueJson: '0' }],
      },
    ],
    automations: [
      {
        name: 'construct-pulse',
        functionName: 'construct_pulse',
        targetMode: 'type',
        targetTypeName: 'WorldState',
        triggerType: 'schedule',
        scheduleKind: 'interval',
        intervalMs: PULSE_INTERVAL_MS,
        maxTargets: 1,
        description: 'Advances WorldState.pulses once a minute while anyone is in the app.',
      },
    ],
  };
}

/** Everything `kit.deploy` needs, in one array. */
export function constructBlueprints() {
  return [
    progressionBlueprint({ typePrefix: 'Construct', xpAuthority: 'server' }),
    leaderboardsBlueprint({ typePrefix: 'Paint', submitAuthority: 'host' }),
    constructWorldBlueprint(),
  ];
}

/** Names the client reads back (kept here so the facade and seed agree). */
export const MODEL_NAMES = {
  programType: 'Program',
  worldStateType: 'WorldState',
  progressType: 'ConstructProgress',
  leaderboardEntryType: 'PaintLeaderboardEntry',
  pulseAutomation: 'construct-pulse',
};
