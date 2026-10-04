#!/usr/bin/env node
// What @crowdedkingdoms/construct is about to publish may not name a private repository or
// internal infrastructure. The list is CrowdyJS's (scripts/check-content-policy.mjs there),
// and the corpus is the one that matters: the files `npm pack` would put in the tarball,
// asked of npm itself rather than guessed from `files`, because the published artifact is
// what a leak reaches and a git-backed search polices only the input.
//
// Usage: node scripts/ci/check-package-content.mjs [package dir, default packages/construct]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DENYLIST = [
  'cks-udp-api',
  'cks-michael-root',
  'cks-project-root',
  'MessageType.hpp',
  'wire-protocol-reference',
  'P2P_SECRET',
  'P2P_TOKEN',
  'CHANNEL_MUTATION',
  'peer port',
  'port 9081',
  ':9081',
  'buddydev',
  'BUDDY_BUILDER',
  'dev-run-buddy',
];

/**
 * The file list out of `npm pack --dry-run --json`, whose shape npm has changed: npm 10 and 11
 * print an array of packs, npm 12 an object keyed by package name. An empty or unknown shape
 * throws: a check that found no files has not checked anything.
 */
export function filesFromPackJson(parsed) {
  const packs = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.files)
      ? [parsed]
      : Object.values(parsed ?? {});
  const pack = packs[0];
  if (!pack || !Array.isArray(pack.files)) {
    throw new Error(`unexpected npm pack --json output: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return pack.files.map((f) => f.path);
}

export function packedFiles(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return filesFromPackJson(JSON.parse(out));
}

export function findings(dir, files, terms = DENYLIST) {
  const found = [];
  for (const path of files) {
    const text = readFileSync(join(dir, path), 'utf8');
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((line, i) => {
      for (const term of terms) {
        if (line.includes(term)) found.push({ term, path, line: i + 1 });
      }
    });
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] ?? 'packages/construct');
  const files = packedFiles(dir);
  const found = findings(dir, files);
  console.log(`[content] ${files.length} packed files scanned for ${DENYLIST.length} terms`);
  if (files.length === 0) {
    console.error('::error::npm pack listed no files, so nothing was checked');
    process.exit(1);
  }
  for (const f of found) console.error(`::error file=${f.path},line=${f.line}::names '${f.term}'`);
  process.exit(found.length ? 1 : 0);
}
