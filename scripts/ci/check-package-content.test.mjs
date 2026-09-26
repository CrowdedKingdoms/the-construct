import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filesFromPackJson } from './check-package-content.mjs';

const pack = {
  name: '@crowdedkingdoms/construct',
  files: [{ path: 'README.md' }, { path: 'src/index.ts' }],
};

test('reads npm 10 and 11: an array of packs', () => {
  assert.deepEqual(filesFromPackJson([pack]), ['README.md', 'src/index.ts']);
});

test('reads npm 12: an object keyed by package name', () => {
  assert.deepEqual(filesFromPackJson({ '@crowdedkingdoms/construct': pack }), [
    'README.md',
    'src/index.ts',
  ]);
});

test('reads a single pack object', () => {
  assert.deepEqual(filesFromPackJson(pack), ['README.md', 'src/index.ts']);
});

test('refuses output with no pack in it', () => {
  assert.throws(() => filesFromPackJson([]), /unexpected npm pack --json output/);
  assert.throws(() => filesFromPackJson({}), /unexpected npm pack --json output/);
  assert.throws(() => filesFromPackJson(null), /unexpected npm pack --json output/);
});
