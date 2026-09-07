/**
 * Shared plumbing for the headless scripts: environment, sign-in, and a
 * game client on the app's own endpoint. Mirrors what the browser does in
 * NetworkManager so the scripts exercise the same platform path.
 *
 * Environment (a `.env.local` is read if present; real env wins):
 *   CONSTRUCT_EMAIL / CONSTRUCT_PASSWORD  the developer account (required)
 *   CROWDY_HTTP_URL                        API root override (optional)
 *   APP_ID                                 for seed/smoke (or VITE_APP_ID)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createCrowdyClient } from '@crowdedkingdoms/crowdyjs';

export function loadDotEnv(rootDir = process.cwd()) {
  for (const file of ['.env', '.env.local']) {
    try {
      const text = readFileSync(path.join(rootDir, file), 'utf8');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line
          .slice(eq + 1)
          .trim()
          .replace(/^(['"])(.*)\1$/, '$2');
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // absent is fine
    }
  }
}

export function requireEnv(name, hint) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. ${hint ?? ''}`.trim());
    process.exit(2);
  }
  return value;
}

export function apiRoot() {
  const override = process.env.CROWDY_HTTP_URL?.trim() || process.env.VITE_CROWDY_HTTP_URL?.trim();
  return override ? override.replace(/\/graphql\/?$/, '').replace(/\/$/, '') : undefined;
}

/** Identity client signed in with the developer's credentials. */
export async function signIn(log = console.log) {
  const email = requireEnv(
    'CONSTRUCT_EMAIL',
    'Set CONSTRUCT_EMAIL and CONSTRUCT_PASSWORD (an account you own).',
  );
  const password = requireEnv('CONSTRUCT_PASSWORD');
  const root = apiRoot();
  const identity = createCrowdyClient(root ? { httpUrl: root } : {});
  try {
    await identity.auth.login({ email, password });
  } catch (error) {
    if (!/already|UNAUTHENTICATED|credentials/i.test(String(error))) throw error;
    // A brand-new address: register it (same credentials) and continue.
    log(`Login failed (${messageOf(error)}); registering ${email}…`);
    await identity.auth.register({ email, password });
  }
  const me = await identity.users.me();
  log(`Signed in as ${me.email ?? me.userId} (user ${me.userId})`);
  return { identity, user: me };
}

/** Mint an app token and build a client on the app's endpoint. */
export async function enterApp(identity, appId, log = console.log) {
  const minted = await identity.portal.mintAppToken(appId);
  const httpUrl = minted.gameApiUrl ?? apiRoot();
  const game = createCrowdyClient({
    ...(httpUrl ? { httpUrl } : {}),
    ...(minted.gameApiWsUrl ? { wsUrl: minted.gameApiWsUrl } : {}),
    realtime: { discoveryUrl: minted.discoveryUrl ?? undefined },
  });
  game.setToken(minted.token);
  log(`Entered app ${appId}${httpUrl ? ` via ${httpUrl}` : ''}`);
  return game;
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      out[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    } else out._.push(arg);
  }
  return out;
}
