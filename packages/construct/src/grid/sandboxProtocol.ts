/** window.postMessage traffic between the game page and a grid program sandbox. */
export const GRID_PROGRAM_SOURCE = 'construct-grid-program';

/** Sandbox -> page (the CrowdyJS traffic itself rides the MessagePort, not this). */
export type GridProgramSandboxMessage =
  | { type: 'ready' }
  | { type: 'started' }
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error'; line: string }
  | { type: 'error'; message: string };
