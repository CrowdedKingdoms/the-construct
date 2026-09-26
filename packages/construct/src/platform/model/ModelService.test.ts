import { describe, expect, it, vi } from 'vitest';

// The SDK root barrel drags Monaco into a unit test; the network layer only needs the constants.
vi.mock('@crowdedkingdoms/crowdyjs', () => ({
  CROWDY_DEFAULT_HTTP_ORIGIN: 'https://ck.test.example',
  CROWDY_DEFAULT_TIER: 'test',
}));

const { ModelService } = await import('./ModelService');

function withHub(replies: Record<string, unknown>) {
  const logs: string[] = [];
  const hub = {
    call: vi.fn(async (method: string) => {
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
  const session = { network: { worldHub: hub, log: (line: string) => logs.push(line) } };
  return { model: new ModelService(session as never), hub, logs };
}

describe('ModelService on the world hub', () => {
  it('reads the pulse count and caches it for the HUD poll', async () => {
    const { model, hub } = withHub({
      world: { pulses: 7, lastPulseAt: 1, pulseEveryMs: 60_000 },
    });
    expect(await model.world()).toEqual({ pulses: 7, seeded: true });
    await model.world();
    expect(hub.call).toHaveBeenCalledTimes(1);
    model.invalidate();
    await model.world();
    expect(hub.call).toHaveBeenCalledTimes(2);
  });

  it('says the hub is missing instead of throwing', async () => {
    const { model, logs } = withHub({
      world: new Error('NotFound: no such type'),
      progress: new Error('x'),
    });
    expect(await model.world()).toEqual({ pulses: 0, seeded: false });
    expect(await model.progress()).toBeNull();
    expect(logs.some((line) => /world state unavailable: NotFound/.test(line))).toBe(true);
  });

  it('maps the catalog and the player progression to their records', async () => {
    const { model } = withHub({
      programs: {
        programs: [{ programId: 1, sceneId: 'paint', name: 'Paint', description: 'd' }],
      },
      progress: { player: '42', xp: 3, level: 2, skillPoints: 1 },
    });
    expect(await model.programs()).toEqual([
      { containerId: 'program-1', programId: 1, sceneId: 'paint', name: 'Paint', description: 'd' },
    ]);
    expect(await model.progress()).toEqual({ containerId: '42', xp: 3, level: 2, skillPoints: 1 });
  });
});
