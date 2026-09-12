/**
 * Answers one question for the player-host observation frame: is a human at
 * the controls right now?
 *
 * The frame's `humanInputActive` used to come from the Crowdy Agent control
 * gate, which the in-browser harness replaced. The harness only observes (it
 * has no dispatch path), but the observation is still what the model reads,
 * so it must be true rather than a hard-coded `false`. "Active" means a key,
 * pointer or wheel event on the page within the last {@link ACTIVE_WINDOW_MS}.
 */
export const ACTIVE_WINDOW_MS = 1_500;

const EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  'keydown',
  'pointerdown',
  'pointermove',
  'wheel',
  'touchstart',
];

export class HumanInputMonitor {
  private lastInputAt = 0;
  private readonly target: Window | null;
  private readonly onInput = (): void => {
    this.lastInputAt = this.now();
  };

  constructor(
    target: Window | null = typeof window === 'undefined' ? null : window,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.target = target;
    for (const type of EVENTS) {
      this.target?.addEventListener(type, this.onInput, { passive: true, capture: true });
    }
  }

  /** True when the player touched the controls within `withinMs`. */
  active(withinMs = ACTIVE_WINDOW_MS): boolean {
    return this.lastInputAt > 0 && this.now() - this.lastInputAt < withinMs;
  }

  dispose(): void {
    for (const type of EVENTS) {
      this.target?.removeEventListener(type, this.onInput, { capture: true });
    }
  }
}
