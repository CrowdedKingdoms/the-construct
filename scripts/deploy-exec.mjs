#!/usr/bin/env node
/**
 * Build and deploy the Construct's ck-exec code (`exec/`) to your app: the crates `exec/ckx.json`
 * names go to `execBuild` as sources (the platform compiles them; no Rust toolchain needed), and
 * the manifest to `execDeploy` with that build, which makes it the app's active version.
 * `npm run setup` and `npm run seed` deploy the same way; run this after changing `exec/`.
 *
 *   CONSTRUCT_EMAIL=... CONSTRUCT_PASSWORD=... APP_ID=<id> npm run deploy:exec [-- --restart]
 *
 * A running hub keeps the version it started with until it stops, and the world hub, its pulse
 * timer pending, does not stop while players are in the app. `--restart` switches every type in
 * the manifest off and on (each persists and stops), so the next call starts it on the new
 * version from its snapshot.
 *
 * Needs the org's `manage_compute` on your account (an org's owner has it). ck-exec is a dev-tier
 * preview, so this works against the dev tier only.
 */
import { deployExec } from '@crowdedkingdoms/construct/platform/onboarding/steps';
import { whenNotBusy } from './lib/busy-retry.mjs';
import {
  developerOnApp,
  loadDotEnv,
  messageOf,
  parseArgs,
  requireEnv,
  signIn,
} from './lib/cli.mjs';
import { execSources } from './lib/exec-sources.mjs';

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const log = (line) => console.log(`  ${line}`);
const appId =
  process.env.APP_ID?.trim() ||
  requireEnv('VITE_APP_ID', 'Set APP_ID (or VITE_APP_ID in .env.local).');

try {
  const { manifest, crates } = execSources();
  const { identity } = await whenNotBusy(() => signIn(log));
  const exec = await whenNotBusy(() => developerOnApp(identity, appId, log));
  try {
    await deployExec(
      exec,
      {
        appId,
        manifest,
        crates,
        restart: args.restart ? Object.keys(manifest.types) : [],
        retry: whenNotBusy,
      },
      log,
    );
  } finally {
    exec.close();
  }
  identity.close();
  console.log('\nck-exec deploy complete.');
  process.exit(0);
} catch (error) {
  console.error(`\nDeploy failed: ${messageOf(error)}`);
  process.exit(1);
}
