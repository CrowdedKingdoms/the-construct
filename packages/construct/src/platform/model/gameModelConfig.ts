/**
 * The Game Model names the platform layer reads back. A game built on the
 * framework defines its model in its own blueprints and tells the platform the
 * names once at boot with {@link configureGameModel}; the defaults are the
 * Construct starter's, so the starter needs no call.
 */
export interface GameModelNames {
  /** Container type of the program catalog (game-within-a-game pads). */
  programType: string;
  /** Container type of the per-app world state singleton. */
  worldStateType: string;
  /** Container type a grid claim is recorded as. */
  claimType: string;
  progressType: string;
  leaderboardEntryType: string;
  pulseAutomation: string;
}

/** Options passed to `client.kit(appId, …)`; must match the deployed blueprints. */
export interface GameKitOptions {
  progression?: { typePrefix: string };
  leaderboards?: { typePrefix: string };
}

export interface GameModelConfig {
  names: GameModelNames;
  kitOptions: GameKitOptions;
}

const CONSTRUCT_DEFAULTS: GameModelConfig = {
  names: {
    programType: 'Program',
    worldStateType: 'WorldState',
    claimType: 'Claim',
    progressType: 'ConstructProgress',
    leaderboardEntryType: 'PaintLeaderboardEntry',
    pulseAutomation: 'construct-pulse',
  },
  kitOptions: {
    progression: { typePrefix: 'Construct' },
    leaderboards: { typePrefix: 'Paint' },
  },
};

let current: GameModelConfig = CONSTRUCT_DEFAULTS;

/** Call once at boot, before the session starts. */
export function configureGameModel(config: {
  names?: Partial<GameModelNames>;
  kitOptions?: GameKitOptions;
}): void {
  current = {
    names: { ...current.names, ...config.names },
    kitOptions: config.kitOptions ?? current.kitOptions,
  };
}

export function gameModelNames(): GameModelNames {
  return current.names;
}

export function gameKitOptions(): GameKitOptions {
  return current.kitOptions;
}
