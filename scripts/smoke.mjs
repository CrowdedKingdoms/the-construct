#!/usr/bin/env node
/**
 * Smoke test against a live app: sign in, mint, bootstrap, and read back what
 * Setup should have produced. Exits non-zero on the first missing piece, with
 * the step that fixes it.
 *
 *   CONSTRUCT_EMAIL=... CONSTRUCT_PASSWORD=... APP_ID=<id> npm run smoke
 */
import { MODEL_NAMES } from '../model/blueprints.mjs';
import { STARTER_TEMPLATES, commonFilesFor } from '../mods/templates/index.mjs';
import { CONSTRUCTOR_TIER_KEYS, CONSTRUCTOR_TIER_NAME } from '../src/platform/onboarding/steps.mjs';
import { enterApp, loadDotEnv, messageOf, requireEnv, signIn } from './lib/cli.mjs';

loadDotEnv();
const appId =
  process.env.APP_ID?.trim() ||
  requireEnv('VITE_APP_ID', 'Set APP_ID (or VITE_APP_ID in .env.local).');
let failures = 0;

function check(ok, label, hint = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !hint ? '' : `\n     ${hint}`}`);
  if (!ok) failures++;
}

try {
  const { identity, user } = await signIn(() => {});
  const game = await enterApp(identity, appId, () => {});

  const boot = await game.serverStatus.gameClientBootstrap(appId);
  check(String(boot.appId) === String(appId), `bootstrap answers for app ${appId}`);
  check(String(boot.me?.userId) === String(user.userId), 'bootstrap sees the signed-in user');

  const tiers = await identity.appAccess.tiers(appId);
  const constructor = tiers.find(
    (t) => t.name === CONSTRUCTOR_TIER_NAME && t.status !== 'archived',
  );
  check(Boolean(constructor), `access tier "${CONSTRUCTOR_TIER_NAME}" exists`, 'run npm run setup');
  if (constructor) {
    const have = new Set((constructor.permissionKeys ?? []).map(String));
    check(
      CONSTRUCTOR_TIER_KEYS.every((k) => have.has(k)),
      'Constructor tier carries the four code keys and use_video_chat',
    );
  }
  const access = await identity.appAccess.myAccess(appId).catch(() => null);
  check(Boolean(access), 'signed-in user has access to the app');

  const policy = await game.marketplace.gridClaimPolicy({ appId }).catch(() => null);
  check(
    policy === 'SELF_CLAIM',
    `grid claim policy is SELF_CLAIM (is ${policy})`,
    'run npm run seed',
  );

  const programs = await game.gameModel.containers({ appId, typeName: MODEL_NAMES.programType });
  check(
    programs.length > 0,
    `Program catalog seeded (${programs.length} programs)`,
    'run npm run seed',
  );
  const world = await game.gameModel.containers({ appId, typeName: MODEL_NAMES.worldStateType });
  check(world.length === 1, 'WorldState singleton exists', 'run npm run seed');

  const common = await game.crowdyStudio.listCommonFiles({ appId, gridId: '' });
  for (const file of STARTER_TEMPLATES.flatMap(commonFilesFor)) {
    check(
      common.some((f) => f.title === file.title && f.content === file.content),
      `Studio common file "${file.slug}" published and current`,
      'run npm run seed',
    );
  }

  game.close();
  identity.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
} catch (error) {
  console.error(`\nSmoke failed: ${messageOf(error)}`);
  process.exit(1);
}
