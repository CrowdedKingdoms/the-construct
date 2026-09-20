/**
 * Holodeck mouse clicks for CLIENT mods. DSH builds click-to-charge from
 * `host_call("pointer_clicks")` / `crowdy::api::pointer_clicks()`: drain the
 * queue every tick, read `holdingMs["0"]` while LMB is down, fire on `up`.
 *
 * Only `.scene-canvas` counts. Studio chrome, text fields, and Monaco are
 * omitted even while Studio is open, so authors can click the world to test.
 */
import { isTextEntry } from '@/engine/Input';

export interface PointerClickEvent {
  t: 'down' | 'up';
  button: number;
  atMs: number;
  heldMs?: number;
  nx: number;
  ny: number;
}

export interface PointerClicksSnapshot {
  nowMs: number;
  buttons: number;
  holdingMs: Record<string, number>;
  clicks: PointerClickEvent[];
}

const MAX_QUEUE = 32;
const CANVAS_SELECTOR = '.scene-canvas';

function canvasOf(target: EventTarget | null): HTMLCanvasElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest(CANVAS_SELECTOR);
}

function ndcFor(event: PointerEvent, canvas: HTMLCanvasElement | null): { nx: number; ny: number } {
  if (typeof document !== 'undefined' && document.pointerLockElement) {
    return { nx: 0, ny: 0 };
  }
  if (!canvas) return { nx: 0, ny: 0 };
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    nx: ((event.clientX - rect.left) / w) * 2 - 1,
    ny: -(((event.clientY - rect.top) / h) * 2 - 1),
  };
}

export class PointerClickBuffer {
  private clicks: PointerClickEvent[] = [];
  private buttons = 0;
  private readonly downAt = new Map<number, number>();
  private lastCanvas: HTMLCanvasElement | null = null;
  private detach: (() => void) | null = null;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Listen on `window` (capture). Safe to call twice. */
  attach(target: Window | null = typeof window === 'undefined' ? null : window): void {
    if (this.detach || !target) return;
    const onDown = (event: PointerEvent) => this.onPointer(event, 'down');
    const onUp = (event: PointerEvent) => this.onPointer(event, 'up');
    target.addEventListener('pointerdown', onDown, true);
    target.addEventListener('pointerup', onUp, true);
    this.detach = () => {
      target.removeEventListener('pointerdown', onDown, true);
      target.removeEventListener('pointerup', onUp, true);
      this.detach = null;
    };
  }

  dispose(): void {
    this.detach?.();
    this.clicks = [];
    this.buttons = 0;
    this.downAt.clear();
    this.lastCanvas = null;
  }

  /** Test helper: enqueue as if the holodeck canvas saw the event. */
  push(event: PointerClickEvent, buttons = this.buttons): void {
    if (event.t === 'down') this.downAt.set(event.button, event.atMs);
    if (event.t === 'up') this.downAt.delete(event.button);
    this.buttons = buttons;
    this.clicks.push(event);
    if (this.clicks.length > MAX_QUEUE) this.clicks.splice(0, this.clicks.length - MAX_QUEUE);
  }

  drainPointerClicks(): PointerClicksSnapshot {
    const nowMs = this.now();
    const clicks = this.clicks;
    this.clicks = [];
    const holdingMs: Record<string, number> = {};
    for (const [button, started] of this.downAt) {
      holdingMs[String(button)] = Math.max(0, nowMs - started);
    }
    return { nowMs, buttons: this.buttons, holdingMs, clicks };
  }

  private onPointer(event: PointerEvent, phase: 'down' | 'up'): void {
    if (isTextEntry(event.target)) return;
    const canvas =
      canvasOf(event.target) ??
      (phase === 'up' && this.downAt.has(event.button) ? this.lastCanvas : null);
    if (phase === 'down') {
      if (!canvas) return;
      this.lastCanvas = canvas;
    } else if (!this.downAt.has(event.button)) {
      return;
    }
    const atMs = this.now();
    const { nx, ny } = ndcFor(event, canvas);
    const heldMs =
      phase === 'up' && this.downAt.has(event.button)
        ? Math.max(0, atMs - (this.downAt.get(event.button) ?? atMs))
        : undefined;
    this.push(
      {
        t: phase,
        button: event.button,
        atMs,
        ...(heldMs !== undefined ? { heldMs } : {}),
        nx,
        ny,
      },
      event.buttons,
    );
  }
}
