#!/usr/bin/env node
// The built grid program page must load the sandbox bootstrap. `@crowdedkingdoms/construct`'s
// `sandbox/boot` is imported only for what it does on load, so a bundler drops it unless the
// package's `sideEffects` lists it; construct 0.2.0 didn't, and dist/grid-program.html shipped
// Vite's preload polyfill and nothing else, so every JS grid program failed to start.
//
// Usage (after `npm run build`): node scripts/ci/check-grid-program-bundle.mjs [dist]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const html = readFileSync(join(dist, 'grid-program.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*\bsrc="\/?([^"]+)"/g)].map((m) => m[1]);
// The boot's own listener, a string the minifier keeps.
const boots = scripts.filter((src) =>
  readFileSync(join(dist, src), 'utf8').includes('unhandledrejection'),
);
if (boots.length === 0) {
  console.error(
    `::error::${dist}/grid-program.html loads no grid program sandbox (scripts: ${scripts.join(', ') || 'none'}). Check that the construct package's "sideEffects" lists ./sandbox/boot.ts.`,
  );
  process.exit(1);
}
console.log(`grid-program.html loads the sandbox: ${boots.join(', ')}`);
