import { createCrowdyClient } from '@crowdedkingdoms/crowdyjs';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Studio agent pane: the in-browser DeepSeek Harness boots inside Crowdy
 * Studio, a screenshot reaches it, a prompt completes a turn through the
 * metered model endpoint, and the pane reports who paid.
 *
 * Same conventions as smoke.spec.ts: everything comes from the environment,
 * the account is an ordinary player on the app named by APP_ID, and nothing
 * here touches an operator mutation or a database. Who pays (player wallet or
 * org wallet) is the app's policy in Management; the test reads it back
 * through `crowdyStudioModelUsage` and asserts the usage row agrees. Wallet
 * debits and the org-pays path are covered by ck-api's own tests.
 *
 *   CONSTRUCT_E2E=1 CONSTRUCT_EMAIL CONSTRUCT_PASSWORD APP_ID   run it
 *   CONSTRUCT_E2E_SEED_TOKEN=1 CROWDY_HTTP_URL                 local stack without hosted login
 *   CONSTRUCT_E2E_GRID="x,z"                                    a chunk this player already owns
 *                                                               (default: claim -10,0,-6 like smoke)
 */
const live = process.env.CONSTRUCT_E2E === '1';
const email = process.env.CONSTRUCT_EMAIL;
const password = process.env.CONSTRUCT_PASSWORD;
const appId = process.env.APP_ID ?? process.env.VITE_APP_ID;
const seedToken = process.env.CONSTRUCT_E2E_SEED_TOKEN === '1';

function envHandleFor(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  return `${url.hostname}${url.port ? `_${url.port}` : ''}`;
}

/** The API origin the page dials: an explicit override or the page itself (same-origin proxy). */
function apiHttpUrl(pageOrigin: string): string {
  const configured =
    process.env.CROWDY_HTTP_URL?.trim() || process.env.VITE_CROWDY_HTTP_URL?.trim();
  if (!configured || configured === 'same-origin' || configured === '/') return pageOrigin;
  return configured;
}

async function mintAppSession(pageOrigin: string) {
  const httpUrl = process.env.CROWDY_HTTP_URL?.trim();
  if (!httpUrl) throw new Error('CONSTRUCT_E2E_SEED_TOKEN=1 requires CROWDY_HTTP_URL');
  const identity = createCrowdyClient({ httpUrl });
  await identity.auth.login({ email: email!, password: password! });
  const minted = await identity.portal.mintAppToken(appId!);
  return {
    token: minted.token,
    handle: envHandleFor(apiHttpUrl(pageOrigin)),
    id: appId!,
    route: {
      appId: String(minted.appId ?? appId),
      gameApiUrl: null,
      gameApiWsUrl: null,
      discoveryUrl: null,
      expiresAt: minted.expiresAt,
    },
  };
}

async function writeAppSession(page: Page, session: Awaited<ReturnType<typeof mintAppSession>>) {
  await page.evaluate(({ token, route, handle, id }) => {
    localStorage.setItem(`construct:app-token:${handle}`, token);
    localStorage.setItem(`construct:app-route:${handle}`, JSON.stringify(route));
    localStorage.setItem(`construct:app-id:${handle}`, id);
    localStorage.setItem('construct:env-handle', handle);
  }, session);
}

/** Sign in the way smoke.spec.ts does: hosted Studio login, seed only as an opt-in fallback. */
async function signIn(page: Page): Promise<void> {
  const signInButton = page.getByRole('button', { name: 'Sign in with Crowded Kingdoms' });
  if (!(await signInButton.isVisible())) return;
  await signInButton.click();
  const reachedLogin = await page
    .waitForURL(/\/login/, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  let hosted = false;
  if (reachedLogin) {
    await page.getByLabel(/email address/i).fill(email!);
    await page.getByRole('button', { name: /^continue$/i }).click();
    const passwordBox = page.getByLabel(/^password$/i);
    hosted = await passwordBox
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (hosted) {
      await passwordBox.fill(password!);
      await page.getByRole('button', { name: /^sign in$/i }).click();
      const consent = page.getByRole('button', { name: /continue to/i });
      await consent
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => consent.click())
        .catch(() => undefined);
    }
  }
  if (!hosted) {
    if (!seedToken) {
      throw new Error(
        'Hosted sign-in did not complete. Set CONSTRUCT_E2E_SEED_TOKEN=1 and CROWDY_HTTP_URL only for a local stack that cannot show the password form.',
      );
    }
    await page.goto(`/?app=${appId}`);
    await writeAppSession(page, await mintAppSession(new URL(page.url()).origin));
    await page.reload();
  }
}

/** The page's own app token, for read-only usage queries from the test. */
async function readAppToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const handle = localStorage.getItem('construct:env-handle');
    return handle ? localStorage.getItem(`construct:app-token:${handle}`) : null;
  });
  if (!token) throw new Error('the page holds no app token after sign-in');
  return token;
}

test('the Studio agent pane boots in the browser, sees a screenshot, completes a metered turn and names the payer', async ({
  page,
}) => {
  test.skip(
    !live || !email || !password || !appId,
    'set CONSTRUCT_E2E=1 CONSTRUCT_EMAIL CONSTRUCT_PASSWORD APP_ID',
  );
  test.setTimeout(240_000);
  page.on('dialog', (dialog) => void dialog.accept());
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));

  await page.goto(`/?app=${appId}`);
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Crowdy Studio (M)' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator('canvas.scene-canvas')).toHaveCount(1);

  // The harness is served by this page under /dsh/ (copied from the
  // @crowdedkingdoms/crowdy-dsh package by scripts/copy-dsh-web.mjs).
  const stamp = await page.request.get('/dsh/BUILD.json');
  expect(stamp.ok(), 'public/dsh carries the harness artifact and its BUILD.json').toBe(true);
  const build = (await stamp.json()) as {
    upstream?: { tag?: string };
    crowdyjs?: { version?: string };
  };
  console.log(`[dsh] harness ${build.upstream?.tag} with CrowdyJS ${build.crowdyjs?.version}`);

  // Stand on a chunk and open Studio there. CONSTRUCT_E2E_GRID names a chunk
  // this player already owns; otherwise the claim pad from smoke.spec.ts is
  // used and claimed (not idempotent across accounts, see that spec).
  const [gx, gz] = (process.env.CONSTRUCT_E2E_GRID ?? '-10,-6').split(',').map(Number);
  await page.evaluate(
    ({ x, z }) => {
      const g = (
        window as unknown as {
          __construct?: { router: { current: { setLocalPosition(p: unknown): void } } };
        }
      ).__construct;
      if (!g) throw new Error('dev handle unavailable — run e2e against a dev-mode server');
      g.router.current.setLocalPosition({ x, y: 0, z });
    },
    { x: gx, z: gz },
  );
  await page.keyboard.press('KeyE');
  const shell = page.locator('#ck-crowdy-studio-embed-shell');
  await expect(shell).toBeVisible({ timeout: 60_000 });

  // The agent pane docks beside the editor; the first visit shows the
  // provider-data notice, which records consent through the SDK.
  const pane = page.locator('.ck-crowdy-studio-dsh');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const accept = pane.getByRole('button', { name: /start the agent/i });
  if (await accept.isVisible({ timeout: 3_000 }).catch(() => false)) await accept.click();

  // The iframe is same-origin, sandboxed as far as that allows, and boots the harness.
  const frameElement = pane.locator('iframe.ck-crowdy-studio-dsh-frame');
  await expect(frameElement).toBeVisible({ timeout: 15_000 });
  expect(await frameElement.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
  await expect(pane.locator('.ck-crowdy-studio-dsh-status')).toHaveText(/Ready/, {
    timeout: 90_000,
  });
  const frame = page.frameLocator('iframe.ck-crowdy-studio-dsh-frame');
  const dismiss = frame.getByRole('button', { name: /continue/i });
  if (
    await dismiss
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await dismiss.click();
  }
  const composer = frame.locator('textarea, [contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 60_000 });

  // The Screenshot button captures the WebGL frame and hands it to the agent.
  const capture = pane.locator('button.ck-crowdy-studio-dsh-capture');
  await expect(capture).toBeEnabled({ timeout: 10_000 });
  await capture.click();
  await expect(pane.locator('.ck-crowdy-studio-dsh-message')).toContainText(
    /Shared capture-.*with the agent/i,
    {
      timeout: 15_000,
    },
  );

  // One turn through POST /v1/model/chat/completions, with the player's token.
  const token = await readAppToken(page);
  const api = createCrowdyClient({ httpUrl: apiHttpUrl(new URL(page.url()).origin) });
  api.setToken(token);
  const usageQuery = `query($appId: BigInt!) { crowdyStudioModelUsage(appId: $appId, limit: 3) {
    payerKind todayRequests todayChargeMicrousd recent { payerKind status chargeMicrousd }
  } }`;
  type Usage = {
    crowdyStudioModelUsage: {
      payerKind: 'PLAYER' | 'ORG' | 'PLATFORM';
      todayRequests: string;
      todayChargeMicrousd: string;
      recent: Array<{ payerKind: string; status: string; chargeMicrousd: string }>;
    };
  };
  const before = await api.graphql.query<Usage>(usageQuery, { appId });
  const requestsBefore = Number(before.crowdyStudioModelUsage.todayRequests);

  await composer.click();
  await composer.fill(
    'In one short sentence, what files does this project have? Do not edit anything.',
  );
  await page.keyboard.press('Enter');

  await expect
    .poll(
      async () =>
        Number(
          (await api.graphql.query<Usage>(usageQuery, { appId })).crowdyStudioModelUsage
            .todayRequests,
        ),
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBeGreaterThan(requestsBefore);
  const after = await api.graphql.query<Usage>(usageQuery, { appId });
  const latest = after.crowdyStudioModelUsage.recent[0];
  expect(latest?.status).toBe('COMPLETED');
  // The row's payer is whatever the app's policy says; the pane must say the same.
  expect(latest?.payerKind).toBe(after.crowdyStudioModelUsage.payerKind);
  const paidBy =
    after.crowdyStudioModelUsage.payerKind === 'PLAYER'
      ? /paid by your wallet/i
      : after.crowdyStudioModelUsage.payerKind === 'ORG'
        ? /paid by the app's wallet/i
        : /paid by the platform/i;
  await expect(pane.locator('.ck-crowdy-studio-dsh-spend')).toContainText(paidBy, {
    timeout: 45_000,
  });

  await page.keyboard.press('Escape');
  await expect(shell).toBeHidden({ timeout: 10_000 });
});
