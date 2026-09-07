import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The API origin baked into the installed CrowdyJS build.
 *
 * Every published dist-tag carries the public origin for its tier
 * (`latest` -> production, `@dev` -> dev, `@test` -> test), and the browser
 * client defaults to it when no `httpUrl` is configured. Node-side tooling
 * (the Vite config's CSP, the headless setup script) needs the same value
 * without importing the SDK's root barrel, which drags the Monaco graph into
 * Node. The constant lives in one small generated module, so read that file.
 *
 * Returns null when the SDK is not installed yet (first `npm install`).
 */
export function sdkDefaultHttpOrigin(rootDir = process.cwd()) {
  const candidates = [
    path.join(rootDir, 'node_modules/@crowdedkingdoms/crowdyjs/dist/default-origin.js'),
  ];
  try {
    const require = createRequire(path.join(rootDir, 'package.json'));
    const pkg = require.resolve('@crowdedkingdoms/crowdyjs/package.json');
    candidates.unshift(path.join(path.dirname(pkg), 'dist/default-origin.js'));
  } catch {
    // exports map may hide package.json; fall through to the literal path
  }
  for (const file of candidates) {
    try {
      const source = readFileSync(file, 'utf8');
      const match = source.match(/CROWDY_DEFAULT_HTTP_ORIGIN\s*=\s*['"]([^'"]+)['"]/);
      if (match) return match[1];
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The tier the installed SDK declares, if it declares one. */
export function sdkDefaultTier(rootDir = process.cwd()) {
  try {
    const file = path.join(rootDir, 'node_modules/@crowdedkingdoms/crowdyjs/dist/default-origin.js');
    const source = readFileSync(file, 'utf8');
    const match = source.match(/CROWDY_DEFAULT_TIER\s*=\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
