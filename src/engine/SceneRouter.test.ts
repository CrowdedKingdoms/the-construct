import { describe, expect, it, vi } from 'vitest';

import type { GameScene, SceneContext, SceneSize } from '@/engine/GameScene';
import { SceneRouter } from '@/engine/SceneRouter';
import { NEUTRAL_POSE } from '@/platform/realtime/actorCodec';

function fakeScene(
  id: string,
  programId: number,
  failMount = false,
): GameScene & { mounted: number; unmounted: number } {
  let pos = { x: 0, y: 0, z: 0 };
  return {
    id,
    programId,
    mounted: 0,
    unmounted: 0,
    mount() {
      if (failMount) throw new Error(`${id} cannot mount`);
      this.mounted++;
    },
    unmount() {
      this.unmounted++;
    },
    update() {},
    resize() {},
    localPose: () => ({ ...NEUTRAL_POSE, ...pos }),
    setLocalPosition(p) {
      pos = { x: p.x, y: p.y, z: p.z };
    },
  };
}

const size: SceneSize = { width: 100, height: 50, rightInset: 0 };
const context = {} as SceneContext;

describe('SceneRouter', () => {
  it('constructs scenes lazily, mounts once per load, and unmounts the previous', async () => {
    const router = new SceneRouter();
    const hub = fakeScene('hub', 0);
    const prog = fakeScene('prog', 1);
    const hubFactory = vi.fn(() => hub);
    router.register('hub', hubFactory);
    router.register('prog', () => prog);
    router.bind(context, size);
    expect(hubFactory).not.toHaveBeenCalled();
    await router.load('hub');
    await router.load('prog', { x: 3, y: 0, z: 4 });
    expect(hub.mounted).toBe(1);
    expect(hub.unmounted).toBe(1);
    expect(prog.localPose()).toMatchObject({ x: 3, z: 4 });
    expect(router.current?.id).toBe('prog');
    await router.load('prog');
    expect(prog.mounted).toBe(1);
  });

  it('restores the previous scene when a mount fails', async () => {
    const router = new SceneRouter();
    const hub = fakeScene('hub', 0);
    const broken = fakeScene('broken', 2, true);
    router.register('hub', () => hub);
    router.register('broken', () => broken);
    router.bind(context, size);
    await router.load('hub', { x: 7, y: 0, z: 7 });
    const errors: unknown[] = [];
    router.events.on('error', (e) => errors.push(e));
    await expect(router.load('broken')).rejects.toThrow(/cannot mount/);
    expect(router.current?.id).toBe('hub');
    expect(hub.mounted).toBe(2);
    expect(hub.localPose()).toMatchObject({ x: 7, z: 7 });
    expect(errors).toHaveLength(1);
  });

  it('refuses unknown ids and loads before bind', async () => {
    const router = new SceneRouter();
    await expect(router.load('nope')).rejects.toThrow(/bind/);
    router.bind(context, size);
    await expect(router.load('nope')).rejects.toThrow(/No scene registered/);
  });
});
