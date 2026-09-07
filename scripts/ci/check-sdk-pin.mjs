#!/usr/bin/env node
/**
 * The CrowdyJS pin must be EXACT and must match the branch's tier.
 *
 * Why exact: the SDK publishes prereleases per tier (`X.Y.Z-dev.N` under the
 * `@dev` dist-tag, `X.Y.Z-test.N` under `@test`, plain `X.Y.Z` under `latest`)
 * and a caret range can never match a prerelease, so `^15.4.2-dev.1` silently
 * resolves to something else or nothing. Why per tier: each published build
 * carries the API origin of its tier baked in, so the `dev` branch of this repo
 * must consume `-dev.` builds and `prod` plain versions — or an unconfigured
 * clone would dial the wrong environment.
 *
 * On a pull request the tier is the BASE branch (what the merge would land on);
 * on a push it is the branch itself; on a feature branch there is no tier and
 * only the exactness rules run.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const NAME = '@crowdedkingdoms/crowdyjs';
const declared = pkg.dependencies?.[NAME];
const locked = lock.packages?.[`node_modules/${NAME}`]?.version;
const branch = (
  process.env.GITHUB_BASE_REF ||
  process.env.GITHUB_REF_NAME ||
  process.argv[2] ||
  ''
).trim();
const tier = ['dev', 'test', 'prod'].includes(branch) ? branch : null;

const problems = [];
if (!declared) problems.push(`${NAME} is not a dependency`);
else {
  if (!/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(declared)) {
    problems.push(
      `pin "${declared}" is not exact (no ^ ~ or ranges; a caret cannot match a prerelease)`,
    );
  }
  if (locked && locked !== declared)
    problems.push(`package-lock resolves ${locked} but package.json pins ${declared}`);
  if (tier === 'dev' && !/-dev\.\d+$/.test(declared))
    problems.push(`branch dev must pin an -dev.N prerelease, got ${declared}`);
  if (tier === 'test' && !/-test\.\d+$/.test(declared))
    problems.push(`branch test must pin a -test.N prerelease, got ${declared}`);
  if (tier === 'prod' && /-/.test(declared))
    problems.push(`branch prod must pin a plain release, got ${declared}`);
}

console.log(
  `${NAME}: package.json ${declared ?? '(none)'} · lock ${locked ?? '(none)'} · tier ${tier ?? 'n/a (feature branch)'}`,
);
if (problems.length) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('  ✓ pin is exact and tier-aligned');
