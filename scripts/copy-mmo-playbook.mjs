#!/usr/bin/env node
/**
 * Copy the MMO Anything playbook into public/mmo/ so the dock can read it
 * same-origin. The files are not committed: public/mmo is gitignored, like
 * public/dsh. A checkout without the playbook skips the copy and the
 * read_playbook tool reports that the page is not there.
 *
 *   MMO_ANYTHING_DIR=/path/to/mmo-anything
 *   CONSTRUCT_SKIP_MMO=1
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const constructRoot = path.resolve(here, '..');
const appRoot = path.resolve(process.env.CONSTRUCT_APP_ROOT ?? process.cwd());
const target = path.join(appRoot, 'public', 'mmo');

if (process.env.CONSTRUCT_SKIP_MMO === '1') {
  console.log('copy-mmo-playbook: CONSTRUCT_SKIP_MMO=1, leaving public/mmo as is');
  process.exit(0);
}

const source =
  process.env.MMO_ANYTHING_DIR?.trim() || path.resolve(constructRoot, '..', 'mmo-anything');

if (!existsSync(path.join(source, 'playbook'))) {
  console.log(
    `copy-mmo-playbook: no playbook at ${source}; public/mmo was not written. ` +
      'Set MMO_ANYTHING_DIR to the mmo-anything checkout.',
  );
  process.exit(0);
}

function markdownUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

function copyTree(fromDir, toDir) {
  for (const file of markdownUnder(fromDir)) {
    const rel = path.relative(fromDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(toDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(file, dest);
  }
}

copyTree(path.join(source, 'playbook'), path.join(target, 'playbook'));
copyTree(path.join(source, '.agents', 'skills'), path.join(target, 'skills'));
const readme = path.join(source, 'README.md');
if (existsSync(readme)) cpSync(readme, path.join(target, 'README.md'));

let rev;
try {
  rev = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  rev = 'unknown';
}
writeFileSync(
  path.join(target, 'SOURCE.txt'),
  `Copied by copy-mmo-playbook from ${source} at ${rev} on ${new Date().toISOString()}.\n` +
    'Do not edit or commit: public/mmo is gitignored and regenerated before every dev/build.\n',
);
console.log(`copy-mmo-playbook: public/mmo <- ${source} @ ${rev}`);
