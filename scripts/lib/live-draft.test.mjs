import assert from 'node:assert/strict';
import test from 'node:test';

import { draftFile, isWritableGamePath } from './live-draft.mjs';

test('draft paths stay inside the working copy', () => {
  assert.equal(isWritableGamePath('src/scenes/holodeck-three/HolodeckScene.ts'), true);
  assert.equal(isWritableGamePath('model/catalog.mjs'), true);
  assert.equal(isWritableGamePath('exec/construct/src/lib.rs'), true);
  assert.equal(isWritableGamePath('server/src/main.rs'), false);
  assert.equal(isWritableGamePath('src/scenes/../../model/catalog.mjs'), false);
  assert.equal(draftFile('/tmp/game', 'src/scenes/a.ts'), '/tmp/game/src/scenes/a.ts');
  assert.equal(draftFile('/tmp/game', '../secrets'), null);
});
