import { describe, expect, it } from 'vitest';

import {
  DraftTransformError,
  draftModuleUrl,
  errorModuleSource,
  hostShimSource,
  parseDraftUrl,
  resolveSpecifier,
  transformDraftModule,
} from './draftModules';

const BASE = '/the-construct/';
const PATHS = new Set([
  'src/game/content.ts',
  'src/game/programs.ts',
  'src/scenes/race/RaceScene.ts',
  'src/scenes/race/index.ts',
  'model/catalog.mjs',
  'model/tracks.json',
]);

describe('parseDraftUrl', () => {
  it('reads module, host and missing URLs under the base, and nothing else', () => {
    expect(parseDraftUrl('/the-construct/__draft/g3/src/game/content.ts', BASE)).toEqual({
      kind: 'module',
      generation: 3,
      path: 'src/game/content.ts',
    });
    expect(parseDraftUrl('/the-construct/__draft/host/three.js', BASE)).toEqual({
      kind: 'host',
      specifier: 'three',
    });
    expect(
      parseDraftUrl(
        `/the-construct/__draft/host/${encodeURIComponent('@crowdedkingdoms/construct/engine/GameScene')}.js`,
        BASE,
      ),
    ).toEqual({ kind: 'host', specifier: '@crowdedkingdoms/construct/engine/GameScene' });
    expect(parseDraftUrl('/the-construct/assets/index.js', BASE)).toBeNull();
    expect(parseDraftUrl('/the-construct/dsh/index.html', BASE)).toBeNull();
    expect(parseDraftUrl('/the-construct/__draft/g1/../../secrets', BASE)).toBeNull();
    expect(parseDraftUrl('/the-construct/__draft/g1/src/%2E%2E/x.ts', BASE)).toBeNull();
  });

  it('round-trips a module URL', () => {
    const url = draftModuleUrl(BASE, 7, 'src/scenes/race/RaceScene.ts');
    expect(parseDraftUrl(url, BASE)).toEqual({
      kind: 'module',
      generation: 7,
      path: 'src/scenes/race/RaceScene.ts',
    });
  });
});

describe('resolveSpecifier', () => {
  it('resolves relative, alias and root paths the way Vite does here', () => {
    expect(resolveSpecifier('./programs', 'src/game/content.ts', PATHS)).toEqual({
      kind: 'draft',
      path: 'src/game/programs.ts',
    });
    expect(resolveSpecifier('@/scenes/race', 'src/game/content.ts', PATHS)).toEqual({
      kind: 'draft',
      path: 'src/scenes/race/index.ts',
    });
    expect(resolveSpecifier('../../model/catalog.mjs', 'src/game/programs.ts', PATHS)).toEqual({
      kind: 'draft',
      path: 'model/catalog.mjs',
    });
    expect(resolveSpecifier('/model/tracks.json', 'src/game/programs.ts', PATHS)).toEqual({
      kind: 'draft',
      path: 'model/tracks.json',
    });
  });

  it('sends bare and framework imports to the host, and reports what is missing', () => {
    expect(resolveSpecifier('three', 'src/scenes/race/RaceScene.ts', PATHS)).toEqual({
      kind: 'host',
      specifier: 'three',
    });
    expect(
      resolveSpecifier('@crowdedkingdoms/construct/engine/GameScene', 'src/game/content.ts', PATHS),
    ).toEqual({
      kind: 'host',
      specifier: '@crowdedkingdoms/construct/engine/GameScene',
    });
    expect(resolveSpecifier('./nope', 'src/game/content.ts', PATHS)).toEqual({ kind: 'missing' });
    expect(resolveSpecifier('../../../outside', 'src/game/content.ts', PATHS)).toEqual({
      kind: 'missing',
    });
  });
});

describe('transformDraftModule', () => {
  it('strips types, keeps line numbers, and rewrites every import', async () => {
    const source = [
      "import type { GameScene } from '@crowdedkingdoms/construct/engine/GameScene';",
      "import { Scene } from 'three';",
      "import { PROGRAMS } from './programs';",
      'export const count: number = PROGRAMS.length;',
      "export const later = () => import('@/scenes/race');",
      'export const dev = import.meta.env.DEV;',
      'if (import.meta.hot) import.meta.hot.accept();',
      'export const scene: GameScene | null = new Scene() as unknown as GameScene;',
    ].join('\n');
    const code = await transformDraftModule({
      source,
      path: 'src/game/content.ts',
      generation: 2,
      base: BASE,
      paths: PATHS,
    });
    expect(code).not.toContain('GameScene/');
    expect(code).toMatch(/from ['"]\/the-construct\/__draft\/host\/three\.js['"]/);
    expect(code).toMatch(/from ['"]\/the-construct\/__draft\/g2\/src\/game\/programs\.ts['"]/);
    expect(code).toContain('import("/the-construct/__draft/g2/src/scenes/race/index.ts")');
    expect(code).toContain('globalThis.__constructDraftEnv.DEV');
    expect(code).toContain('if ((void 0))');
    expect(code).not.toMatch(/: number|as unknown/);
    expect(code.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('serves JSON as a default export and refuses other files', async () => {
    const json = await transformDraftModule({
      source: '{"laps": 3}',
      path: 'model/tracks.json',
      generation: 1,
      base: BASE,
      paths: PATHS,
    });
    expect(json).toBe('export default {"laps":3};\n');
    await expect(
      transformDraftModule({
        source: 'body{}',
        path: 'src/style.css',
        generation: 1,
        base: BASE,
        paths: PATHS,
      }),
    ).rejects.toThrow(/cannot be previewed/);
  });

  it('reports a syntax error with its file and line', async () => {
    const failure = transformDraftModule({
      source: 'export const a = 1;\nexport const b = ;\n',
      path: 'src/game/programs.ts',
      generation: 1,
      base: BASE,
      paths: PATHS,
    });
    await expect(failure).rejects.toBeInstanceOf(DraftTransformError);
    await failure.catch((error: DraftTransformError) => {
      expect(error.error).toMatchObject({ path: 'src/game/programs.ts', line: 2 });
    });
  });

  it('points an unknown draft import at a module that explains itself', async () => {
    const code = await transformDraftModule({
      source: "import { x } from './gone';\nexport default x;\n",
      path: 'src/game/content.ts',
      generation: 1,
      base: BASE,
      paths: PATHS,
    });
    const url = /['"]([^'"]+missing[^'"]+)['"]/.exec(code)?.[1] ?? '';
    expect(parseDraftUrl(url, BASE)).toEqual({
      kind: 'missing',
      importer: 'src/game/content.ts',
      specifier: './gone',
    });
  });
});

describe('module sources', () => {
  it('re-exports host names, reserved and default ones included', () => {
    const code = hostShimSource('three', ['Scene', 'default', 'delete']);
    expect(code).toContain('globalThis.__constructDraftHost("three")');
    expect(code).toContain('export { __e0 as Scene };');
    expect(code).toContain('export { __e1 as default };');
    expect(code).toContain('export { __e2 as "delete" };');
  });

  it('throws with the location and keeps it for the preview status', () => {
    const code = errorModuleSource({
      path: 'src/a.ts',
      line: 3,
      column: 2,
      message: 'Unexpected token',
    });
    expect(code).toContain('"src/a.ts:3:2: Unexpected token"');
    expect(code).toContain(
      'error.preview = {"path":"src/a.ts","line":3,"column":2,"message":"Unexpected token"}',
    );
  });
});
