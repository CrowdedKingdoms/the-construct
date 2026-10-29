import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyPlaybook, skillFrontmatter } from './copy-playbook.mjs';

test('reads one-line frontmatter and the dock marker', () => {
  assert.deepEqual(
    skillFrontmatter(
      '---\nname: scene\ndescription: "Add a scene."\nmetadata:\n  surface: dock\n---\n# Body\n',
    ),
    { name: 'scene', description: 'Add a scene.', surface: 'dock' },
  );
  assert.equal(skillFrontmatter('# No frontmatter'), null);
  assert.equal(skillFrontmatter('---\nname: ship\ndescription: Deploy.\n---\n').surface, undefined);
});

test('copies the pages and indexes only the skills marked for the dock', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'playbook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const target = path.join(dir, 'public', 'playbook');
  mkdirSync(path.join(source, 'playbook'), { recursive: true });
  writeFileSync(path.join(source, 'playbook', 'authoring-loop.md'), '# Loop\n');
  for (const [name, surface] of [
    ['dock-scene', 'dock'],
    ['ship', null],
  ]) {
    mkdirSync(path.join(source, '.agents', 'skills', name), { recursive: true });
    writeFileSync(
      path.join(source, '.agents', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill.\n${surface ? `metadata:\n  surface: ${surface}\n` : ''}---\nBody\n`,
    );
  }
  writeFileSync(path.join(source, 'secret.txt'), 'not markdown');
  const index = copyPlaybook(source, target);
  assert.deepEqual(index, {
    skills: [
      { name: 'dock-scene', description: 'dock-scene skill.', page: 'skills/dock-scene/SKILL.md' },
    ],
  });
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(target, 'skills', 'index.json'), 'utf8')),
    index,
  );
  assert.equal(
    readFileSync(path.join(target, 'playbook', 'authoring-loop.md'), 'utf8'),
    '# Loop\n',
  );
  assert.throws(() => readFileSync(path.join(target, 'secret.txt')));
});
