/**
 * Keyboard + pointer state shared by every scene, with one switch overlays
 * flip: `suppressed`. While an overlay (Crowdy Studio, the chat box, the Setup
 * wizard) has focus, gameplay must not see keys — but the overlay's own
 * shortcuts still fire through `onKey`.
 *
 * Pointer lock is true when the lock element is the attached root *or any
 * descendant* (the scene canvas). Look also works as an RMB drag so insecure
 * HTTP (the IDE browser on a public IP) can still turn the camera.
 */
import { Controls } from '@/engine/controls';

export type KeyHandler = (event: KeyboardEvent) => void;

export interface PointerState {
  x: number;
  y: number;
  /** Movement since the last frame (consumed by `takePointerDelta`). */
  dx: number;
  dy: number;
  down: boolean;
  locked: boolean;
  /** `MouseEvent.buttons` bitfield (1 LMB, 2 RMB, 4 MMB). */
  buttons: number;
  alt: boolean;
}

const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_INPUT_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  // Monaco's editor surface.
  return Boolean(target.closest('.monaco-editor'));
}

/** True when pointer lock is on `root` or a node inside it (the scene canvas). */
export function isPointerLockOn(root: EventTarget | null, lockElement: Element | null): boolean {
  if (!lockElement || !(root instanceof Node)) return false;
  return lockElement === root || root.contains(lockElement);
}

export class Input {
  private readonly keys = new Set<string>();
  private readonly keyHandlers = new Map<string, Set<KeyHandler>>();
  private readonly pointerState: PointerState = {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    down: false,
    locked: false,
    buttons: 0,
    alt: false,
  };
  private suppressedDepth = 0;
  private detach: (() => void) | null = null;
  private attachedRoot: HTMLElement | null = null;
  private wheelY = 0;
  /** Escape cancels RMB look until the button is released. */
  private lookCancelled = false;

  attach(target: HTMLElement): void {
    if (this.detach) return;
    this.attachedRoot = target;
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
      this.pointerState.buttons = event.buttons;
      this.pointerState.alt = event.altKey;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (this.suppressed || isTextEntry(event.target)) return;
      this.pointerState.down = true;
      this.pointerState.buttons = event.buttons;
      this.pointerState.alt = event.altKey;
      this.pointerState.x = event.clientX;
      this.pointerState.y = event.clientY;
      if (event.button === 2) this.lookCancelled = false;
    };
    const onPointerUp = (event: PointerEvent) => {
      this.pointerState.buttons = event.buttons;
      this.pointerState.alt = event.altKey;
      if (event.buttons === 0) this.pointerState.down = false;
      if ((event.buttons & 2) === 0) this.lookCancelled = false;
    };
    const onLockChange = () => {
      this.pointerState.locked = isPointerLockOn(target, document.pointerLockElement);
    };
    const onWheel = (event: WheelEvent) => {
      if (this.suppressed || isTextEntry(event.target)) return;
      if (
        this.attachedRoot &&
        event.target instanceof Node &&
        !this.attachedRoot.contains(event.target)
      ) {
        return;
      }
      this.wheelY += event.deltaY;
      event.preventDefault();
    };
    const onContextMenu = (event: Event) => {
      if (this.isLooking() || (this.pointerState.buttons & 2) !== 0) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onLockChange);
    this.detach = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onLockChange);
      this.detach = null;
      this.attachedRoot = null;
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

  anyDown(codes: readonly string[]): boolean {
    return codes.some((code) => this.keys.has(code));
  }

  /** -1..1 on each axis from WASD / arrows. */
  axes(): { x: number; y: number } {
    const x =
      (this.anyDown(Controls.moveRight) ? 1 : 0) - (this.anyDown(Controls.moveLeft) ? 1 : 0);
    const y =
      (this.anyDown(Controls.moveForward) ? 1 : 0) - (this.anyDown(Controls.moveBack) ? 1 : 0);
    return { x, y };
  }

  isRun(): boolean {
    return this.anyDown(Controls.run);
  }

  /**
   * Pointer-lock look, or RMB held (and not cancelled by Escape). Used by the
   * holodeck so insecure HTTP can still turn the camera.
   */
  isLooking(): boolean {
    if (this.suppressed) return false;
    if (this.pointerState.locked) return true;
    if (this.lookCancelled) return false;
    return (this.pointerState.buttons & 2) !== 0;
  }

  /** MMB, or Alt+LMB — Paint camera pan without stealing paint/erase. */
  isPanning(): boolean {
    if (this.suppressed) return false;
    if ((this.pointerState.buttons & 4) !== 0) return true;
    return this.pointerState.alt && (this.pointerState.buttons & 1) !== 0;
  }

  /** Exit pointer lock and cancel an in-progress RMB look. */
  exitLook(): void {
    this.lookCancelled = true;
    if (typeof document !== 'undefined' && document.pointerLockElement) {
      document.exitPointerLock();
    }
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

  onKeys(codes: readonly string[], handler: KeyHandler): () => void {
    const releases = codes.map((code) => this.onKey(code, handler));
    return () => {
      for (const release of releases) release();
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

  /** Read and reset accumulated wheel deltaY (once per frame). */
  takeWheel(): number {
    const y = this.wheelY;
    this.wheelY = 0;
    return y;
  }
}
