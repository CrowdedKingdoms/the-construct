import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCrowdyClient } from '@crowdedkingdoms/crowdyjs';
import { expect, test, type Page } from '@playwright/test';

const envFile = resolve(process.env.HOME ?? '', '.local-tier/construct-player.env');
const adminEnvFile = resolve(process.env.HOME ?? '', '.local-tier/local-admin.env');

function readEnv(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1)];
        }),
    );
  } catch {
    return {};
  }
}

const playerEnv = readEnv(envFile);
const adminEnv = readEnv(adminEnvFile);
const appId = process.env.APP_ID ?? '89512017969152';
const email = playerEnv.PLAYER_EMAIL;
const password = playerEnv.PLAYER_PASSWORD;
const graphqlEndpoint = 'http://127.0.0.1:3000/graphql';

function envHandleFor(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  return `${url.hostname}${url.port ? `_${url.port}` : ''}`;
}

async function mintPlayerSession(pageOrigin: string) {
  const identity = createCrowdyClient({ graphqlEndpoint });
  await identity.auth.login({ email: email!, password: password! });
  const minted = await identity.portal.mintAppToken(appId);
  const handle = envHandleFor(pageOrigin);
  return {
    token: minted.token,
    handle,
    id: appId,
    route: {
      appId,
      gameApiUrl: null,
      gameApiWsUrl: null,
      discoveryUrl: null,
      expiresAt: minted.expiresAt,
    },
  };
}

async function writeSession(page: Page, session: Awaited<ReturnType<typeof mintPlayerSession>>) {
  await page.evaluate(({ token, route, handle, id }) => {
    localStorage.setItem(`construct:app-token:${handle}`, token);
    localStorage.setItem(`construct:app-route:${handle}`, JSON.stringify(route));
    localStorage.setItem(`construct:app-id:${handle}`, id);
    localStorage.setItem('construct:env-handle', handle);
    localStorage.setItem(`construct:owned-grids:${handle}`, JSON.stringify({
      '-1,-1': {
        gridId: '89534419714048',
        bounds: {
          low: { x: '-1', y: '0', z: '-1' },
          high: { x: '-1', y: '0', z: '-1' },
        },
        effectiveKeys: ['write_server_code', 'write_client_code', 'run_server_code', 'run_client_code', 'use_studio_agent'],
      },
    }));
  }, session);
}

test.describe('In-browser DeepSeek Harness e2e flow in The Construct', () => {
  test('Studio agent boots in-browser, edits project, takes screenshot, charges wallet, and honors org payer', async ({
    page,
  }) => {
    test.skip(!email || !password, 'construct-player.env credentials required');

    // 1. Seed player app session
    await page.goto('/');
    const session = await mintPlayerSession(new URL(page.url()).origin);
    await writeSession(page, session);

    // Ensure provider data consent for this app
    const client = createCrowdyClient({ graphqlEndpoint });
    client.setToken(session.token);
    await client.graphql.query(
      `mutation { crowdyStudioSetProviderConsent(input: { appId: "${appId}", consented: true }) { consented } }`,
    ).catch(() => {});

    // Ensure player wallet has positive balance ($5.00) and app policy is PLAYER payer
    const adminSdk = createCrowdyClient({ graphqlEndpoint });
    if (adminEnv.ADMIN_EMAIL && adminEnv.ADMIN_PASSWORD) {
      await adminSdk.auth.login({ email: adminEnv.ADMIN_EMAIL, password: adminEnv.ADMIN_PASSWORD });
      await adminSdk.graphql.query(
        `mutation { cpSetCrowdyStudioAgentPlatformPolicy(input: { funding: { billingMode: "METERED", walletDebitEnabled: true }, idempotencyKey: "init-platform-${Date.now()}" }) { revision } }`,
      ).catch(() => {});
      await adminSdk.graphql.query(
        `mutation { setCrowdyStudioAgentPolicy(input: { appId: "${appId}", funding: { payerKind: "PLAYER" }, idempotencyKey: "init-app-${Date.now()}" }) { revision } }`,
      ).catch(() => {});
      try {
        const { execSync } = await import('node:child_process');
        execSync(
          `PGPASSWORD=ck_app_local psql -h 127.0.0.10 -p 5440 -U ck_app -d crowded_kingdoms -c "DELETE FROM crowdy_agent_app_policies WHERE app_id = ${appId}"`,
          { stdio: 'ignore' },
        );
      } catch {}
    }

    // 2. Open game
    page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 300)));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`/?app=${appId}`);

    // Wait for canvas to load
    await expect(page.locator('canvas.scene-canvas')).toBeVisible({ timeout: 45_000 });

    // Teleport to the claim & studio pad
    await page.evaluate(async () => {
      const g = (window as unknown as { __construct?: { router: { current: { setLocalPosition(p: unknown): void } } } }).__construct;
      if (g?.router?.current) {
        g.router.current.setLocalPosition({ x: -10, y: 0, z: -6 });
      }
    });

    // Open Studio on the claimed chunk
    const openResult = await page.evaluate(async () => {
      const g = (window as unknown as {
        __construct?: {
          session: {
            studio: {
              claimHereAndOpen(pos: unknown): Promise<unknown>;
              toggle(pos: unknown): Promise<unknown>;
            };
          };
          router: { current: { setLocalPosition(p: unknown): void } };
        };
      }).__construct;
      if (!g) return 'dev handle unavailable';
      g.router.current.setLocalPosition({ x: -10, y: 0, z: -6 });
      try {
        const res = await g.session.studio.claimHereAndOpen({ x: -10, y: 0, z: -6 });
        return { claim: res };
      } catch (err1) {
        try {
          const res2 = await g.session.studio.toggle({ x: -10, y: 0, z: -6 });
          return { toggle: res2, err1: String(err1) };
        } catch (err2) {
          return { err1: String(err1), err2: String(err2) };
        }
      }
    });
    console.log('--- studio open result ---', JSON.stringify(openResult));

    const shell = page.locator('#ck-crowdy-studio-embed-shell');
    await expect(shell).toBeVisible({ timeout: 25_000 });

    // 3. Verify Studio and DSH pane are mounted
    const dshPane = page.locator('.ck-crowdy-studio-dsh');
    await expect(dshPane).toBeVisible({ timeout: 20_000 });

    // If notice is visible, click accept
    const noticeBtn = dshPane.getByRole('button', { name: /start the agent/i });
    if (await noticeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await noticeBtn.click();
    }

    // 4. Verify DSH iframe boots
    const iframe = dshPane.locator('iframe.ck-crowdy-studio-dsh-frame');
    await expect(iframe).toBeVisible({ timeout: 15_000 });
    const frame = page.frameLocator('iframe.ck-crowdy-studio-dsh-frame');

    // Dismiss testing notice if shown inside the iframe
    const cont = frame.getByRole('button', { name: /continue/i });
    if (await cont.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true).catch(() => false)) {
      await cont.click();
      await frame.locator('[class*=_mask_]').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    }
    await page.waitForTimeout(500);

    // Open existing session or create a new session
    console.log('--- frame body text ---\n' + (await frame.locator('body').innerText().catch(() => 'frame body error')));
    await page.screenshot({ path: '/tmp/dsh-journal/e2e-frame.png' });
    const sessionItem = frame.locator('[class*=sidebar] [class*=session], [data-session-id], a[href*="session"]').first();
    if (await sessionItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sessionItem.click().catch(() => {});
    } else {
      const newSession = frame.getByRole('button', { name: /new session/i }).first();
      if (await newSession.isVisible({ timeout: 5000 }).catch(() => false)) {
        await newSession.click().catch(() => {});
      }
    }
    await page.waitForTimeout(1000);

    // 5. Verify the chat composer is ready in the iframe
    const composer = frame.locator('textarea, [contenteditable="true"]').first();
    await expect(composer).toBeVisible({ timeout: 60_000 });

    // 6. Test Screenshot button in pane header
    const screenshotBtn = dshPane.locator('button.ck-crowdy-studio-dsh-capture');
    await expect(screenshotBtn).toBeEnabled({ timeout: 10_000 });
    await screenshotBtn.click();
    await expect(dshPane.locator('.ck-crowdy-studio-dsh-message')).toContainText(/Shared capture-.*with the agent/i, {
      timeout: 15_000,
    });

    // 7. Send a prompt to the agent (which calls POST /v1/model/chat/completions)
    const prompt = 'Add a comment to server/src/lib.rs and run draft_test';
    const dismissModal = frame.getByRole('button', { name: /continue/i });
    if (await dismissModal.isVisible().catch(() => false)) {
      await dismissModal.click();
      await frame.locator('[class*=_mask_]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    await composer.click();
    await composer.fill(prompt);
    await page.keyboard.press('Enter');

    // Wait for the agent to complete the turn
    await expect(frame.locator('body')).toContainText(/Done\./, { timeout: 60_000 });

    // 8. Verify the spend line shows PLAYER payer
    const spendLine = dshPane.locator('.ck-crowdy-studio-dsh-spend');
    await expect(spendLine).toBeVisible();
    await expect(spendLine).toContainText(/paid by your wallet/i);

    // 9. Verify model_endpoint_usage recorded the turn
    const usageQuery = await client.graphql.query<{
      crowdyStudioModelUsage: {
        payerKind: string;
        todayRequests: string;
        todayChargeMicrousd: string;
        recent: Array<{ payerKind: string; status: string; chargeMicrousd: string }>;
      };
    }>(`query { crowdyStudioModelUsage(appId: "${appId}", limit: 5) { payerKind todayRequests todayChargeMicrousd recent { payerKind status chargeMicrousd } } }`);
    expect(usageQuery.crowdyStudioModelUsage.payerKind).toBe('PLAYER');
    expect(Number(usageQuery.crowdyStudioModelUsage.todayRequests)).toBeGreaterThan(0);
    expect(usageQuery.crowdyStudioModelUsage.recent[0]?.status).toBe('COMPLETED');
    expect(usageQuery.crowdyStudioModelUsage.recent[0]?.payerKind).toBe('PLAYER');

    // 10. Test org-pays toggle: fund org wallet and switch to ORG payer via mutation
    try {
      const { execSync } = await import('node:child_process');
      execSync(
        `PGPASSWORD=ck_app_local psql -h 127.0.0.10 -p 5440 -U ck_app -d crowded_kingdoms -c "INSERT INTO org_wallets (org_id, wallet_id, balance_cents, updated_at) VALUES (89512017788928, 900000000000002, 1000, now()) ON CONFLICT (org_id) DO UPDATE SET balance_cents = 1000"`,
        { stdio: 'ignore' },
      );
    } catch {}

    const adminAppPolicy = await adminSdk.graphql.query<{
      setCrowdyStudioAgentPolicy: {
        revision: string;
        funding: { payerKind: string; billingMode: string };
      };
    }>(`mutation {
      setCrowdyStudioAgentPolicy(input: { appId: "${appId}", funding: { payerKind: "ORG" }, idempotencyKey: "e2e-org-${Date.now()}" }) {
        revision funding { payerKind billingMode }
      }
    }`);
    expect(adminAppPolicy.setCrowdyStudioAgentPolicy.funding.payerKind).toBe('ORG');

    // Invalidate the 60s replica cache so the next request pulls the fresh policy immediately
    try {
      const { execSync } = await import('node:child_process');
      execSync(`PGPASSWORD=ck_app_local psql -h 127.0.0.10 -p 5440 -U ck_app -d crowded_kingdoms -c "DELETE FROM crowdy_agent_app_policies WHERE app_id = ${appId}"`, { stdio: 'ignore' });
    } catch {}

    // Trigger another turn from composer
    const initialRequests = Number(usageQuery.crowdyStudioModelUsage.todayRequests);
    await composer.click();
    await composer.fill('Another quick turn for org payer test');
    await page.keyboard.press('Enter');

    // Wait until model_endpoint_usage records the second request
    await expect.poll(async () => {
      const res = await client.graphql.query<{
        crowdyStudioModelUsage: {
          todayRequests: string;
          recent: Array<{ payerKind: string; status: string }>;
        };
      }>(`query { crowdyStudioModelUsage(appId: "${appId}", limit: 2) { todayRequests recent { payerKind status } } }`);
      return Number(res.crowdyStudioModelUsage.todayRequests);
    }, { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(initialRequests);

    // Verify latest usage row is recorded as ORG payer!
    const orgUsageQuery = await client.graphql.query<{
      crowdyStudioModelUsage: {
        recent: Array<{ payerKind: string; status: string }>;
      };
    }>(`query { crowdyStudioModelUsage(appId: "${appId}", limit: 2) { recent { payerKind status } } }`);
    expect(orgUsageQuery.crowdyStudioModelUsage.recent[0]?.payerKind).toBe('ORG');
    expect(orgUsageQuery.crowdyStudioModelUsage.recent[0]?.status).toBe('COMPLETED');
  });
});
