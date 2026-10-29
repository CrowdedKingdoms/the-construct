import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('virtual:construct-draft-host', () => ({
  default: { three: async () => ({ Scene: class {}, default: 'three' }) },
}));

import type { GameScene } from '../../engine/GameScene';
import { CONTENT_API, GameContentHost } from './content';
import { DraftLoader } from './draftLoader';
import type { DraftChangeEvent, DraftEntry } from './sdk';

const scene = () => ({ id: 'home' }) as unknown as GameScene;

function host() {
  return new GameContentHost({
    contentApi: CONTENT_API,
    scenes: { home: scene },
    home: { sceneId: 'home', spawn: { x: 0, y: 0, z: 0 } },
    programs: [],
  });
}

class FakeStore {
  entries: DraftEntry[] = [];
  revision = 0;
  readonly texts = new Map<string, string>();
  private readonly listeners = new Set<(event: DraftChangeEvent) => void>();
  snapshot() {
    return {
      baseCommitSha: 'b'.repeat(40),
      revision: this.revision,
      entries: this.entries,
      deleted: [],
      truncated: false,
    };
  }
  subscribe(listener: (event: DraftChangeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async read(paths: readonly string[]) {
    return {
      files: paths
        .filter((p) => this.texts.has(p))
        .map((p) => ({ path: p, hash: 'h', content: this.texts.get(p)! })),
      missing: paths.filter((p) => !this.texts.has(p) && !this.entries.some((e) => e.path === p)),
      binary: paths.filter((p) => this.entries.some((e) => e.path === p && e.binary)),
    };
  }
  list(files: Record<string, string>, binary: string[] = []) {
    this.entries = [
      ...Object.keys(files).map((path) => ({
        path,
        hash: 'h',
        size: 1,
        binary: false,
        dirty: false,
      })),
      ...binary.map((path) => ({ path, hash: 'h', size: 1, binary: true, dirty: false })),
    ];
    for (const [path, text] of Object.entries(files)) this.texts.set(path, text);
    this.revision += 1;
    for (const listener of this.listeners)
      listener({ revision: this.revision, baseCommitSha: null, changes: [], source: 'reload' });
  }
}

function fakeServiceWorker() {
  const worker = {};
  let onMessage: ((event: unknown) => void) | undefined;
  const unregister = vi.fn(async () => true);
  const container = {
    controller: worker,
    ready: Promise.resolve({ active: worker }),
    register: vi.fn(async () => ({ active: worker, unregister })),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') onMessage = listener;
    },
    removeEventListener: vi.fn(),
    startMessages: vi.fn(),
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
  const ask = (data: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        resolve(event.data as Record<string, unknown>);
      };
      onMessage?.({
        source: worker,
        data: { type: 'construct-draft', ...data },
        ports: [channel.port2],
      });
    });
  return { container, ask, unregister };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('DraftLoader', () => {
  it('registers the worker at the base and waits for the store to list files before loading', async () => {
    const sw = fakeServiceWorker();
    const store = new FakeStore();
    const content = host();
    const loader = await DraftLoader.start({
      base: '/game/',
      store: store as never,
      content,
      env: {},
    });
    expect(sw.container.register).toHaveBeenCalledWith('/game/construct-draft-sw.js', {
      scope: '/game/',
      updateViaCache: 'none',
    });
    await settle();
    expect((await content.status({ timeoutMs: 0 })).ok).toBe(true);

    store.list({ 'README.md': '# Game' });
    await settle();
    const status = await content.status({ timeoutMs: 0 });
    expect(status.ok).toBe(false);
    expect(status.errors[0]?.message).toMatch(/has no src\/game\/content\.ts/);
    loader.dispose();
    expect(sw.unregister).toHaveBeenCalled();
  });

  it("answers the worker's questions from the draft and the build", async () => {
    const sw = fakeServiceWorker();
    const store = new FakeStore();
    store.list(
      { 'src/game/content.ts': 'export default {}', 'model/catalog.mjs': 'export const A = 1' },
      ['art/logo.png'],
    );
    const loader = await DraftLoader.start({
      base: '/',
      store: store as never,
      content: host(),
      env: {},
    });
    expect(await sw.ask({ request: 'manifest', generation: 1 })).toEqual({
      ok: true,
      paths: ['src/game/content.ts', 'model/catalog.mjs'],
    });
    expect(await sw.ask({ request: 'source', generation: 1, path: 'model/catalog.mjs' })).toEqual({
      ok: true,
      source: 'export const A = 1',
    });
    expect(await sw.ask({ request: 'source', generation: 1, path: 'art/logo.png' })).toEqual({
      ok: false,
      message: 'art/logo.png is not a text file.',
    });
    expect(await sw.ask({ request: 'host', specifier: 'three' })).toEqual({
      ok: true,
      names: ['Scene', 'default'],
    });
    const unknown = await sw.ask({ request: 'host', specifier: 'left-pad' });
    expect(unknown.ok).toBe(false);
    expect(String(unknown.message)).toMatch(/not in this build of the game/);
    loader.dispose();
  });
});
