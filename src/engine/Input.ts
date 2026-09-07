/**
 * Keyboard + pointer state shared by every scene, with one switch overlays
 * flip: `suppressed`. While an overlay (Crowdy Studio, the chat box, the Setup
 * wizard) has focus, gameplay must not see keys — but the overlay's own
 * shortcuts still fire through `onKey`.
 */
export type KeyHandler = (event: KeyboardEvent) => void;

export interface PointerState {
  x: number;
  y: number;
  /** Movement since the last frame (consumed by `takePointerDelta`). */
  dx: number;
  dy: number;
  down: boolean;
  locked: boolean;
}

const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_INPUT_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  // Monaco's editor surface.
  return Boolean(target.closest('.monaco-editor'));
}

export class Input {
  private readonly keys = new Set<string>();
  private readonly keyHandlers = new Map<string, Set<KeyHandler>>();
  private readonly pointerState: PointerState = { x: 0, y: 0, dx: 0, dy: 0, down: false, locked: false };
  private suppressedDepth = 0;
  private detach: (() => void) | null = null;

  attach(target: HTMLElement): void {
    if (this.detach) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const inText = isTextEntry(event.target);
      // Shortcuts registered with onKey fire even while suppressed, unless the
      // player is typing in a text field.
      if (!inText) {
        const handlers = this.keyHandlers.get(event.code);
        if (handlers) for (const handler of [...handlers]) handler(event);
      }
      if (this.suppressed || inText) return;
      this.keys.add(event.code);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      this.keys.delete(event.code);
    };
    const onBlur = () => this.keys.clear();
    const onPointerMove = (event: PointerEvent) => {
      if (this.suppressed) return;
      this.pointerState.dx += event.movementX;
      this.pointerState.dy += event.movementY;
      this.pointerState.x = event.clientX;
      this.pointerState.y = event.clientY;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (this.suppressed || isTextEntry(event.target)) return;
      this.pointerState.down = true;
      this.pointerState.x = event.clientX;
      this.pointerState.y = event.clientY;
    };
    const onPointerUp = () => {
      this.pointerState.down = false;
    };
    const onLockChange = () => {
      this.pointerState.locked = document.pointerLockElement === target;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointerlockchange', onLockChange);
    this.detach = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointerlockchange', onLockChange);
      this.detach = null;
    };
  }

  dispose(): void {
    this.detach?.();
    this.keys.clear();
    this.keyHandlers.clear();
  }

  /** True while an overlay owns the keyboard. Nested overlays stack. */
  get suppressed(): boolean {
    return this.suppressedDepth > 0;
  }

  /** Suppress gameplay input; returns the release function. */
  suppress(): () => void {
    this.suppressedDepth += 1;
    this.keys.clear();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suppressedDepth = Math.max(0, this.suppressedDepth - 1);
    };
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** -1..1 on each axis from WASD / arrows. */
  axes(): { x: number; y: number } {
    const x = (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) - (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);
    const y = (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0) - (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0);
    return { x, y };
  }

  onKey(code: string, handler: KeyHandler): () => void {
    let set = this.keyHandlers.get(code);
    if (!set) {
      set = new Set();
      this.keyHandlers.set(code, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  get pointer(): Readonly<PointerState> {
    return this.pointerState;
  }

  /** Read and reset the accumulated pointer delta (once per frame). */
  takePointerDelta(): { dx: number; dy: number } {
    const delta = { dx: this.pointerState.dx, dy: this.pointerState.dy };
    this.pointerState.dx = 0;
    this.pointerState.dy = 0;
    return delta;
  }
}
