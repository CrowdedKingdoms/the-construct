import { describe, expect, it } from 'vitest';

import type { GameScene } from '../../engine/GameScene';
import { CONTENT_API, GameContentHost, assertGameContent, previewErrorOf } from './content';

const scene = (id: string) => ({ id }) as unknown as GameScene;

function content(overrides: Record<string, unknown> = {}) {
  return {
    contentApi: CONTENT_API,
    scenes: { home: () => scene('home'), paint: () => scene('paint') },
    home: { sceneId: 'home', spawn: { x: 0, y: 0, z: 6 } },
    programs: [{ programId: 1, sceneId: 'paint' }],
    ...overrides,
  };
}

describe('assertGameContent', () => {
  it('accepts a module object or its default export', () => {
    expect(assertGameContent({ default: content() }).home.sceneId).toBe('home');
    expect(assertGameContent(content()).programs).toHaveLength(1);
  });

  it('names the fix for a game older than the host', () => {
    expect(() => assertGameContent(content({ contentApi: undefined }))).toThrow(
      /contentApi undefined; this host loads contentApi 1\. Update the game from the template/,
    );
  });

  it('refuses programs and a home that name unregistered scenes', () => {
    expect(() =>
      assertGameContent(content({ home: { sceneId: 'lobby', spawn: { x: 0, y: 0, z: 0 } } })),
    ).toThrow(/home\.sceneId/);
    expect(() =>
      assertGameContent(content({ programs: [{ programId: 2, sceneId: 'race' }] })),
    ).toThrow(/"race"/);
    expect(() =>
      assertGameContent(
        content({
          programs: [
            { programId: 1, sceneId: 'paint' },
            { programId: 1, sceneId: 'home' },
          ],
        }),
      ),
    ).toThrow(/used twice/);
  });
});

describe('GameContentHost', () => {
  it('swaps content, remounts, and reports the revision the world reflects', async () => {
    const host = new GameContentHost(content());
    const mounted: string[] = [];
    host.bind({
      remount: async (next) => void mounted.push(Object.keys(next.scenes).join(',')),
      scene: () => 'home',
    });
    host.noteRevision(3);
    const next = content({
      scenes: { home: () => scene('home'), paint: () => scene('paint'), race: () => scene('race') },
    });
    expect(await host.replace({ default: next })).toBe(true);
    expect(mounted).toEqual(['home,paint,race']);
    expect(host.generation).toBe(1);
    expect(await host.status({ afterRevision: 3, timeoutMs: 10 })).toEqual({
      revision: 3,
      ok: true,
      scene: 'home',
      errors: [],
    });
  });

  it('keeps the old content on screen when the new one fails to mount', async () => {
    const host = new GameContentHost(content());
    const mounted: string[] = [];
    host.bind({
      remount: async (next) => {
        mounted.push(next.home.sceneId);
        if (next.home.sceneId === 'paint') throw new Error('Paint exploded');
      },
      scene: () => undefined,
    });
    const broken = content({ home: { sceneId: 'paint', spawn: { x: 0, y: 0, z: 0 } } });
    expect(await host.replace(broken, 4)).toBe(false);
    expect(host.current.home.sceneId).toBe('home');
    expect(mounted).toEqual(['paint', 'home']);
    const status = await host.status({ timeoutMs: 10 });
    expect(status.ok).toBe(false);
    expect(status.errors[0]?.message).toBe('Paint exploded');
  });

  it('waits for a pending revision and says so when the world never reloads', async () => {
    const host = new GameContentHost(content());
    host.noteRevision(7);
    const pending = await host.status({ timeoutMs: 20 });
    expect(pending.ok).toBe(false);
    expect(pending.note).toMatch(/has not reloaded draft revision 7/);

    const waiting = host.status({ timeoutMs: 1_000 });
    host.settleUnloaded(7, 'README.md is not part of the running game.');
    expect(await waiting).toMatchObject({
      revision: 7,
      ok: true,
      note: 'README.md is not part of the running game.',
    });
  });

  it('records a load that failed before there was content', async () => {
    const host = new GameContentHost(content());
    host.fail([{ path: 'src/scenes/race.ts', line: 3, column: 9, message: 'Unexpected token' }], 2);
    expect(await host.status({ timeoutMs: 10 })).toMatchObject({
      revision: 2,
      ok: false,
      errors: [{ path: 'src/scenes/race.ts', line: 3 }],
    });
  });
});

describe('previewErrorOf', () => {
  it('finds the first repository frame in a draft or dev-server stack', () => {
    const draft = new Error('x is not defined');
    draft.stack =
      'ReferenceError: x is not defined\n    at https://game.example/the-construct/__draft/g4/src/scenes/race.ts:12:7';
    expect(previewErrorOf(draft)).toEqual({
      path: 'src/scenes/race.ts',
      line: 12,
      column: 7,
      message: 'x is not defined',
    });
    const dev = new Error('boom');
    dev.stack = 'Error: boom\n    at http://localhost:5175/src/game/programs.ts?t=1730:30:11';
    expect(previewErrorOf(dev)).toMatchObject({
      path: 'src/game/programs.ts',
      line: 30,
      column: 11,
    });
    expect(previewErrorOf('plain')).toEqual({ message: 'plain' });
  });
});
