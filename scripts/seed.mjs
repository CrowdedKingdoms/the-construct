#!/usr/bin/env node
/**
 * Re-deploy the world hub (ck-exec) and the Crowdy Studio starter files to an existing app
 * (the game-plane onboarding steps). Run after editing `exec/`, `model/` or `mods/`;
 * `npm run deploy:exec -- --restart` also moves a running world hub to the new version.
 *
 *   CONSTRUCT_EMAIL=... CONSTRUCT_PASSWORD=... APP_ID=<id> npm run seed
 */
import { STARTER_TEMPLATES, commonFilesFor, programCommonFiles } from '../mods/templates/index.mjs';
import {
  deployExec,
  ensureSelfClaimPolicy,
  publishStarterFiles,
} from '@crowdedkingdoms/construct/platform/onboarding/steps';
import { whenNotBusy } from './lib/busy-retry.mjs';
import { developerOnApp, enterApp, loadDotEnv, messageOf, requireEnv, signIn } from './lib/cli.mjs';
import { execSources } from './lib/exec-sources.mjs';

loadDotEnv();
const log = (line) => console.log(`  ${line}`);
const appId =
  process.env.APP_ID?.trim() ||
  requireEnv('VITE_APP_ID', 'Set APP_ID (or VITE_APP_ID in .env.local).');

try {
  const { manifest, crates } = execSources();
  const { identity } = await signIn(log);
  const game = await enterApp(identity, appId, log);
  await ensureSelfClaimPolicy(game, { appId }, log);
  const exec = await developerOnApp(identity, appId, log);
  try {
    await deployExec(exec, { appId, manifest, crates, retry: whenNotBusy }, log);
  } finally {
    exec.close();
  }
  await publishStarterFiles(
    game,
    { appId, commonFiles: [...STARTER_TEMPLATES.flatMap(commonFilesFor), ...programCommonFiles()] },
    log,
  );
  console.log('\nSeed complete.');
  game.close();
  identity.close();
  process.exit(0);
} catch (error) {
  console.error(`\nSeed failed: ${messageOf(error)}`);
  process.exit(1);
}
