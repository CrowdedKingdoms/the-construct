import { describe, expect, it, vi } from 'vitest';

import { ClientModLifecycle } from '@/platform/studio/ClientModLifecycle';

const d = (id: string, artifactHash = 'a', capabilityHash = 'c') => ({
  attachmentId: id,
  artifactHash,
  capabilityHash,
});

describe('ClientModLifecycle', () => {
  it('stops every worker when the grid changes', () => {
    const life = new ClientModLifecycle();
    expect(life.enterGrid('g1')).toBe(true);
    const scope = life.scope('g1')!;
    const stop = vi.fn();
    expect(life.track(scope, d('m1'), { stop })).toBe(true);
    expect(life.enterGrid('g1')).toBe(false);
    expect(life.enterGrid('g2')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(life.runningCount).toBe(0);
  });

  it('rejects a worker that finished starting after the grid changed', () => {
    const life = new ClientModLifecycle();
    life.enterGrid('g1');
    const stale = life.scope('g1')!;
    life.enterGrid('g2');
    const stop = vi.fn();
    expect(life.track(stale, d('m1'), { stop })).toBe(false);
    expect(stop).toHaveBeenCalled();
  });

  it('reconciles by immutable hashes', () => {
    const life = new ClientModLifecycle();
    life.enterGrid('g1');
    const scope = life.scope('g1')!;
    const stopA = vi.fn();
    const stopB = vi.fn();
    life.track(scope, d('a'), { stop: stopA });
    life.track(scope, d('b'), { stop: stopB });
    expect(life.reconcile(scope, [d('a'), d('b', 'a2')])).toBe(true);
    expect(stopA).not.toHaveBeenCalled();
    expect(stopB).toHaveBeenCalled();
    expect(life.has('a')).toBe(true);
    expect(life.has('b')).toBe(false);
  });

  it('is inert after shutdown', () => {
    const life = new ClientModLifecycle();
    life.enterGrid('g1');
    life.shutdown();
    expect(life.enterGrid('g2')).toBe(false);
    expect(life.scope('g2')).toBeNull();
  });
});
