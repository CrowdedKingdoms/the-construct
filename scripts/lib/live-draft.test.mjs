import assert from 'node:assert/strict';
import test from 'node:test';

import { draftFile, isWritableGamePath } from './live-draft.mjs';

test('draft paths stay inside the working copy', () => {
  assert.equal(isWritableGamePath('src/scenes/holodeck-three/HolodeckScene.ts'), true);
  assert.equal(isWritableGamePath('src/main.ts'), true);
  assert.equal(isWritableGamePath('src/scenes/pool.mjs'), true);
  assert.equal(isWritableGamePath('server/src/main.rs'), true);
  assert.equal(isWritableGamePath('node_modules/left-pad/index.js'), false);
  assert.equal(isWritableGamePath('.git/config'), false);
  assert.equal(isWritableGamePath('.env'), false);
  assert.equal(isWritableGamePath('src/scenes/../../model/catalog.mjs'), false);
  assert.equal(draftFile('/tmp/game', 'src/scenes/a.ts'), '/tmp/game/src/scenes/a.ts');
  assert.equal(draftFile('/tmp/game', '../secrets'), null);
});
