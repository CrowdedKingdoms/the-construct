#!/usr/bin/env node
/**
 * Re-deploy the game model and the Crowdy Studio starter files to an existing
 * app (the last three onboarding steps). Run after editing `model/` or `mods/`.
 *
 *   CONSTRUCT_EMAIL=... CONSTRUCT_PASSWORD=... APP_ID=<id> npm run seed
 */
import { deployModel, ensureSelfClaimPolicy, publishStarterFiles } from '../src/platform/onboarding/steps.mjs';
import { enterApp, loadDotEnv, messageOf, requireEnv, signIn } from './lib/cli.mjs';

loadDotEnv();
const log = (line) => console.log(`  ${line}`);
const appId = process.env.APP_ID?.trim() || requireEnv('VITE_APP_ID', 'Set APP_ID (or VITE_APP_ID in .env.local).');

try {
  const { identity } = await signIn(log);
  const game = await enterApp(identity, appId, log);
  await ensureSelfClaimPolicy(game, { appId }, log);
  await deployModel(game, { appId }, log);
  await publishStarterFiles(game, { appId }, log);
  console.log('\nSeed complete.');
  game.close();
  identity.close();
  process.exit(0);
} catch (error) {
  console.error(`\nSeed failed: ${messageOf(error)}`);
  process.exit(1);
}
