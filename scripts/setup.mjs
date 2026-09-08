#!/usr/bin/env node
/**
 * Setup, from a shell -- the ONLY place it can run.
 *
 *   CONSTRUCT_EMAIL=you@example.com CONSTRUCT_PASSWORD=... \
 *     npm run setup -- --org "My studio" --app "The Construct" [--slug the-construct] \
 *       [--datacenter or] [--origin https://play.example.com]
 *
 * Creating the org and the app, seeding the model and registering redirect URIs
 * all need an identity session, and a browser game on its own domain cannot
 * hold one (ck-api v1.88.0 serves the direct sign-in mutations only to
 * first-party origins and to non-browser callers like this script). So the
 * in-game wizard is gone and this is the door. It registers the Vite dev
 * server (http://localhost:5175) and every `--origin` as a redirect URI: that
 * list is where hosted sign-in may return the player AND the API's CORS
 * allow-list for the app.
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
    redirectOrigins: [
      'http://localhost:5175',
      ...[]
        .concat(args.origin ?? [])
        .flatMap((o) => String(o).split(','))
        .map((o) => o.trim())
        .filter(Boolean),
    ],
    log,
    onStep: (event) => {
      if (event.status !== 'done')
        console.log(`${event.status === 'running' ? '→' : '✗'} ${event.label}`);
    },
  });
  console.log(`\nAPP_ID=${report.appId}`);
  console.log(`Add to .env.local:  VITE_APP_ID=${report.appId}`);
  console.log(
    'Deploying somewhere other than http://localhost:5175? Re-run with --origin <https://your.host> ' +
      'or add it in Studio > Apps > Settings > Sign-in & redirect URIs.',
  );
  identity.close();
  process.exit(0);
} catch (error) {
  console.error(`\nSetup failed: ${messageOf(error)}`);
  process.exit(1);
}
