import { expect, test } from '@playwright/test';

const live = process.env.CONSTRUCT_E2E === '1';
const email = process.env.CONSTRUCT_EMAIL;
const password = process.env.CONSTRUCT_PASSWORD;
const appId = process.env.APP_ID ?? process.env.VITE_APP_ID;

test('boots cross-origin isolated with the security headers and shows sign-in', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('credentialless');
  expect(response?.headers()['content-security-policy']).toMatch(/worker-src 'self' blob:/);
  // CLIENT mods depend on this being true; a host that drops COOP/COEP fails here.
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.getByRole('heading', { name: 'The Construct' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible();
});

test('sign in, enter the app, join the holodeck, open Crowdy Studio on a claimed chunk', async ({
  page,
}) => {
  test.skip(
    !live || !email || !password || !appId,
    'set CONSTRUCT_E2E=1 CONSTRUCT_EMAIL CONSTRUCT_PASSWORD APP_ID',
  );
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`/?app=${appId}`);
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await page.getByPlaceholder('you@example.com').fill(email!);
  await page.getByPlaceholder('••••••••').fill(password!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Crowdy Studio (M)' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator('.hud-hint')).toContainText(/WASD|Press E/);
  await expect(page.locator('canvas.scene-canvas')).toHaveCount(1);

  // Walk to the claim pad and claim it (idempotent: an owned chunk stays owned).
  await page.evaluate(async () => {
    const g = (
      window as unknown as {
        __construct?: { router: { current: { setLocalPosition(p: unknown): void } } };
      }
    ).__construct;
    if (!g)
      throw new Error(
        'dev handle unavailable — run e2e against a dev-mode server, not the production bundle',
      );
    g.router.current.setLocalPosition({ x: -10, y: 0, z: -6 });
  });
  await page.keyboard.press('KeyE');
  await expect(page.locator('#ck-crowdy-studio-embed-shell')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#ck-crowdy-studio-embed-shell')).toContainText(/Crowdy Studio/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ck-crowdy-studio-embed-shell')).toBeHidden({ timeout: 10_000 });
});
