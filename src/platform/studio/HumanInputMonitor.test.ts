import { describe, expect, it } from 'vitest';

import { ACTIVE_WINDOW_MS, HumanInputMonitor } from './HumanInputMonitor';

function fakeWindow() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    listeners,
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type));
    },
  } as unknown as Window & { fire(type: string): void; listeners: Map<string, Set<EventListener>> };
}

describe('HumanInputMonitor', () => {
  it('reports no human input until the player touches the controls', () => {
    let now = 10_000;
    const win = fakeWindow();
    const monitor = new HumanInputMonitor(win, () => now);
    expect(monitor.active()).toBe(false);

    win.fire('keydown');
    expect(monitor.active()).toBe(true);

    now += ACTIVE_WINDOW_MS - 1;
    expect(monitor.active()).toBe(true);
    now += 2;
    expect(monitor.active()).toBe(false);

    win.fire('pointermove');
    expect(monitor.active()).toBe(true);
    monitor.dispose();
  });

  it('detaches every listener on dispose', () => {
    const win = fakeWindow();
    const monitor = new HumanInputMonitor(win, () => 0);
    const attached = [...win.listeners.values()].reduce((n, set) => n + set.size, 0);
    expect(attached).toBeGreaterThan(0);
    monitor.dispose();
    const remaining = [...win.listeners.values()].reduce((n, set) => n + set.size, 0);
    expect(remaining).toBe(0);
  });
});
