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

  // Camera on (Chromium's fake device, see playwright.config.ts): the toggle
  // reads "on", the self-preview appears, and frames leave over the SDK and
  // are accepted — which is the Constructor tier's use_video_chat doing its
  // job. Then off again, releasing the camera. Before the Studio step so it
  // does not depend on a claim's state.
  await page.keyboard.press('KeyB');
  await expect(page.getByRole('button', { name: 'Camera on (B)' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.camera-preview')).toBeVisible();
  await page.waitForTimeout(1_500);
  const cameraState = await page.evaluate(() => {
    const g = (
      window as unknown as {
        __construct?: {
          session: {
            webcam: { isTransmitting: boolean; error: string | null; framesSent: number };
          };
        };
      }
    ).__construct;
    return g
      ? {
          live: g.session.webcam.isTransmitting,
          error: g.session.webcam.error,
          sent: g.session.webcam.framesSent,
        }
      : null;
  });
  expect(cameraState).toMatchObject({ live: true, error: null });
  expect(cameraState!.sent).toBeGreaterThan(0);
  await page.keyboard.press('KeyB');
  await expect(page.getByRole('button', { name: 'Camera (B)' })).toBeVisible();
  await expect(page.locator('.camera-preview')).toBeHidden();

  // Walk to the claim pad and claim it. NOT idempotent across browser
  // contexts (measured 2026-09-08, dev): a second claim of a chunk this user
  // already owns is refused with GRID_ALREADY_CLAIMED, and the registry path
  // knows the owner but not the keys, so on a re-run against the same app the
  // Studio does not open here. Use a fresh app (npm run setup) or keep the
  // browser profile; the camera step above does not depend on it.
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
