#!/usr/bin/env node
/**
 * Smoke test against a live app: sign in, mint, bootstrap, and read back what
 * Setup should have produced. Exits non-zero on the first missing piece, with
 * the step that fixes it.
 *
 *   CONSTRUCT_EMAIL=... CONSTRUCT_PASSWORD=... APP_ID=<id> npm run smoke
 *
 * The world hub is called as the signed-in player over an exec connection, which is a
 * WebSocket: `npm run smoke` passes Node 20 `--experimental-websocket`.
 */
import { readFileSync } from 'node:fs';

import { PROGRAM_CATALOG } from '../model/catalog.mjs';
import { STARTER_TEMPLATES, commonFilesFor } from '../mods/templates/index.mjs';
import {
  CONSTRUCTOR_TIER_KEYS,
  CONSTRUCTOR_TIER_NAME,
} from '@crowdedkingdoms/construct/platform/onboarding/steps';
import { developerOnApp, enterApp, loadDotEnv, messageOf, requireEnv, signIn } from './lib/cli.mjs';

/** The framework's default world hub (`platform/exec/worldHub.ts`), as `exec/ckx.json` deploys it. */
const WORLD = { nodeType: 'world', key: 'main' };

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
  const manifest = JSON.parse(readFileSync(new URL('../exec/ckx.json', import.meta.url), 'utf8'));
  check(
    manifest.types[WORLD.nodeType]?.client === true,
    `exec/ckx.json deploys the "${WORLD.nodeType}" hub for players`,
  );

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
      'Constructor tier carries the code keys, use_video_chat, and use_studio_agent',
    );
  }

  try {
    const data = await identity.graphql.query(
      `query ConstructSmokeAgent($appId: BigInt!) {
        crowdyStudioAgentEffectivePolicy(appId: $appId) {
          enabled killSwitch allowedModelIds allowedModes disableReasonCode
        }
      }`,
      { appId },
    );
    const effective = data?.crowdyStudioAgentEffectivePolicy;
    if (effective) {
      check(
        effective.enabled === true && effective.killSwitch !== true,
        'Studio Agent effective policy is enabled',
        're-run npm run setup (or Studio → your app → Agent)',
      );
    }
  } catch {
    // Readable only with manage_compute. Third-party smoke still passes.
  }
  const access = await identity.appAccess.myAccess(appId).catch(() => null);
  check(Boolean(access), 'signed-in user has access to the app');

  const policy = await game.marketplace.gridClaimPolicy({ appId }).catch(() => null);
  check(
    policy === 'SELF_CLAIM',
    `grid claim policy is SELF_CLAIM (is ${policy})`,
    'run npm run seed',
  );

  // The world hub, as the game reaches it: the player's app token, one exec connection.
  let hub = null;
  try {
    hub = await game.exec.connect(appId, WORLD);
  } catch (error) {
    check(false, `world hub reachable (${messageOf(error)})`, 'run npm run deploy:exec');
  }
  if (hub) {
    const call = (method, args) =>
      hub.call(WORLD.nodeType, WORLD.key, method, args).catch((error) => ({ error }));
    const status = await call('status');
    check(
      status.ok === true,
      `world hub answers status${status.error ? ` (${messageOf(status.error)})` : ''}`,
      'run npm run deploy:exec',
    );
    const { programs = [] } = await call('programs');
    check(
      PROGRAM_CATALOG.every((p) =>
        programs.some((q) => q.programId === p.programId && q.sceneId === p.sceneId),
      ),
      `world hub serves the program catalog (${programs.length} programs)`,
      'run npm run deploy:exec -- --restart',
    );
    const world = await call('world');
    check(
      typeof world.pulses === 'number',
      `world pulses: ${world.pulses} (one a minute while players are in the app)`,
    );
    const progress = await call('progress');
    check(Number(progress.level) >= 1, `progression reads (level ${progress.level})`);
    const mine = await call('claims', { mine: true });
    check(
      Array.isArray(mine.claims),
      `claim registry answers (${mine.claims?.length ?? '?'} yours of ${mine.total ?? '?'})`,
    );
    hub.close();
  }

  try {
    const exec = await developerOnApp(identity, appId, () => {});
    const status = await exec.exec.status(appId);
    check(
      status.activeVersion != null && !status.disabled && !status.budgetPaused,
      `ck-exec version ${status.activeVersion} is active and switched on`,
      'run npm run deploy:exec',
    );
    exec.close();
  } catch {
    // Readable only with view_compute_diagnostics. Third-party smoke still passes.
  }

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
