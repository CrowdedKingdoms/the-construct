#!/usr/bin/env node
/**
 * Publish this game to Crowdy Games, from a shell -- the ONLY place it can run.
 *
 *   CONSTRUCT_EMAIL=you@example.com CONSTRUCT_PASSWORD=... \
 *     npm run publish [-- --slug my-game] [--dir dist] [--no-build]
 *
 * Afterwards the game is live at the URL this prints: `https://<games host>/<slug>/`,
 * a first-party Crowded Kingdoms page that frames your bundle from its own origin,
 * `https://<slug>.<content host>`. Players sign in through Crowded Kingdoms exactly
 * as they do when you host the build yourself; the SDK's shell bridge handles the
 * difference (CrowdyJS 17.2 EmbeddedHost).
 *
 * WHAT IT DOES, in order:
 *   1. signs in with your account (an IDENTITY session -- the hosting mutations refuse
 *      an app token, so a game can never publish a replacement for itself);
 *   2. reads VITE_APP_ID from .env.local (the id `npm run setup` printed);
 *   3. `claimGameHosting` -- claims the slug (default: the app's slug) once, idempotent;
 *      registers the shell page and the content origin as this app's redirect URIs;
 *   4. `npm run build` unless --no-build (the bundle is served at the root of its own
 *      origin, so the default Vite base is right);
 *   5. `publishDirectory`: hashes dist/, declares the manifest, uploads every file to
 *      its presigned URL with the signed headers, completes the publish (the API
 *      verifies every object, promotes it and invalidates the CDN).
 *
 * The first publish is not LISTED in the Overworld lobby; an operator flips that.
 * The URL works immediately either way.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { publishDirectory } from '@crowdedkingdoms/crowdyjs/hosting';

import { loadDotEnv, messageOf, parseArgs, signIn } from './lib/cli.mjs';

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const log = (line) => console.log(`  ${line}`);

const appId = (process.env.APP_ID ?? process.env.VITE_APP_ID ?? '').trim();
if (!appId) {
  console.error(
    'Missing VITE_APP_ID. Run `npm run setup` (it prints the id) and put `VITE_APP_ID=<id>` in .env.local.',
  );
  process.exit(2);
}

const dir = path.resolve(args.dir ?? 'dist');

try {
  const { identity } = await signIn(log);

  console.log('→ Claiming the hosting slug');
  let game;
  try {
    game = await identity.hosting.claim({
      appId,
      ...(args.slug ? { slug: String(args.slug) } : {}),
    });
  } catch (error) {
    const code = error?.extensions?.code ?? error?.code;
    if (code === 'CONTENT_HOSTING_DISABLED') {
      console.error(
        '\nThis tier does not host third-party games yet. Host the build yourself: docs/HOSTING.md.',
      );
      process.exit(1);
    }
    if (code === 'HOSTED_SLUG_UNAVAILABLE') {
      console.error(`\n${messageOf(error)}\nPick another with: npm run publish -- --slug <name>`);
      process.exit(1);
    }
    throw error;
  }
  log(`slug ${game.slug} -> ${game.launchUrl} (bundle origin ${game.contentOrigin})`);
  if (game.status !== 'LIVE') {
    log(`note: the game is ${game.status}; the page will say so until it is LIVE again`);
  }

  if (args['no-build'] !== 'true') {
    console.log('→ Building');
    const build = spawnSync('npm', ['run', 'build'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  if (!existsSync(path.join(dir, 'index.html'))) {
    console.error(`\nNo index.html in ${dir}. Build first, or pass --dir <built bundle>.`);
    process.exit(1);
  }

  console.log(`→ Publishing ${dir}`);
  const result = await publishDirectory(identity, {
    dir,
    slug: game.slug,
    onManifest: (files, bytes) =>
      log(`${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`),
    onFile: (file, ok, done, total) => {
      if (!ok) log(`FAILED ${file}`);
      else if (done === total || done % 50 === 0) log(`uploaded ${done}/${total}`);
    },
  });
  console.log(`\nPublished ${result.fileCount} files as publish ${result.publishId}.`);
  console.log(`Play it at: ${result.game.launchUrl}`);
  if (!result.game.listed) {
    console.log(
      'It is not listed in the Overworld lobby yet; the URL works now and an operator can list it.',
    );
  }
  identity.close();
  process.exit(0);
} catch (error) {
  console.error(`\nPublish failed: ${messageOf(error)}`);
  const remediation = error?.extensions?.remediation ?? error?.remediation;
  if (remediation) console.error(remediation);
  process.exit(1);
}
