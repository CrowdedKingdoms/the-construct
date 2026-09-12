#!/usr/bin/env node
/**
 * Put the Crowdy Studio agent harness where the page serves it.
 *
 * The harness (DeepSeek Harness web client + packed VFS image, ~13 MB) is
 * published as `@crowdedkingdoms/crowdy-dsh`; its `dist/dsh-web/` is copied
 * into `public/dsh/` here before `vite dev` / `vite build`. `public/dsh/` is
 * gitignored: the artifact is versioned by the package, not by this template,
 * and `public/dsh/BUILD.json` says exactly which build is being served.
 *
 *   DSH_WEB_DIR=/path/to/dist/dsh-web   use a locally built artifact instead
 *   CONSTRUCT_SKIP_DSH=1                 leave public/dsh alone (no agent pane)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'dsh');

if (process.env.CONSTRUCT_SKIP_DSH === '1') {
  console.log('copy-dsh-web: CONSTRUCT_SKIP_DSH=1, leaving public/dsh as is');
  process.exit(0);
}

let source = process.env.DSH_WEB_DIR?.trim();
let origin;
if (source) {
  source = path.resolve(source);
  origin = `DSH_WEB_DIR=${source}`;
} else {
  const require = createRequire(path.join(root, 'package.json'));
  let manifestPath;
  try {
    manifestPath = require.resolve('@crowdedkingdoms/crowdy-dsh/package.json');
  } catch {
    console.error(
      'copy-dsh-web: @crowdedkingdoms/crowdy-dsh is not installed. Run `npm install`, or set ' +
        'DSH_WEB_DIR to a locally built dist/dsh-web, or CONSTRUCT_SKIP_DSH=1 to build without the agent pane.',
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  source = path.join(path.dirname(manifestPath), 'dist', 'dsh-web');
  origin = `${manifest.name}@${manifest.version}`;
}

for (const required of ['index.html', 'BUILD.json', path.join('preview', 'vfs-image.tar.gz')]) {
  if (!existsSync(path.join(source, required))) {
    console.error(`copy-dsh-web: ${source} is not a harness artifact (missing ${required})`);
    process.exit(1);
  }
}

rmSync(target, { recursive: true, force: true });
mkdirSync(path.dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
// A marker for anyone who finds public/dsh in a checkout and wonders.
writeFileSync(
  path.join(target, 'SOURCE.txt'),
  `Copied by scripts/copy-dsh-web.mjs from ${origin} on ${new Date().toISOString()}.\n` +
    'Do not edit or commit: public/dsh is gitignored and regenerated before every dev/build.\n',
);

const stamp = JSON.parse(readFileSync(path.join(target, 'BUILD.json'), 'utf8'));
console.log(
  `copy-dsh-web: public/dsh <- ${origin} ` +
    `(harness ${stamp.upstream?.tag ?? '?'}, CrowdyJS ${stamp.crowdyjs?.version ?? '?'}, ` +
    `built ${stamp.builtAt ?? '?'})`,
);
