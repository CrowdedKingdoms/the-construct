#!/usr/bin/env node
/**
 * Headless Setup: the same onboarding the in-game wizard runs, from a shell.
 *
 *   CONSTRUCT_EMAIL=you@example.com CONSTRUCT_PASSWORD=... \
 *     npm run setup -- --org "My studio" --app "The Construct" [--slug the-construct] [--datacenter or]
 *
 * Prints the app id at the end; put it in `.env.local` as VITE_APP_ID to pin
 * the checkout to that app. Idempotent: re-running finds instead of creating.
 */
import { runOnboarding, slugify } from '../src/platform/onboarding/steps.mjs';
import { enterApp, loadDotEnv, messageOf, parseArgs, signIn } from './lib/cli.mjs';

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const log = (line) => console.log(`  ${line}`);

try {
  const { identity, user } = await signIn(log);
  const orgName = args.org ?? `${user.gamertag ?? 'my'} studio`;
  const appName = args.app ?? 'The Construct';
  const report = await runOnboarding({
    identity,
    userId: String(user.userId),
    enterApp: (appId) => enterApp(identity, appId, log),
    orgName,
    appName,
    appSlug: args.slug ?? slugify(appName),
    datacenter: args.datacenter,
    log,
    onStep: (event) => {
      if (event.status !== 'done')
        console.log(`${event.status === 'running' ? '→' : '✗'} ${event.label}`);
    },
  });
  console.log(`\nAPP_ID=${report.appId}`);
  console.log(`Add to .env.local:  VITE_APP_ID=${report.appId}`);
  identity.close();
  process.exit(0);
} catch (error) {
  console.error(`\nSetup failed: ${messageOf(error)}`);
  process.exit(1);
}
