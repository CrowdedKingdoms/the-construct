import { createCrowdyClient } from '@crowdedkingdoms/crowdyjs';
import { expect, test, type Page } from '@playwright/test';

const live = process.env.CONSTRUCT_E2E === '1';
const email = process.env.CONSTRUCT_EMAIL;
const password = process.env.CONSTRUCT_PASSWORD;
const appId = process.env.APP_ID ?? process.env.VITE_APP_ID;

/** Handle NetworkManager uses to namespace localStorage (API origin of the bundle). */
function envHandleFor(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  return `${url.hostname}${url.port ? `_${url.port}` : ''}`;
}

const seedToken = process.env.CONSTRUCT_E2E_SEED_TOKEN === '1';

/**
 * Optional local-stack escape hatch. Hosted Studio login / consent is the
 * path this repo exists to demonstrate; Node `auth.login` + localStorage
 * seed is only for `CONSTRUCT_E2E_SEED_TOKEN=1` with an explicit
 * `CROWDY_HTTP_URL` (never an implicit loopback).
 */
async function mintAppSession(
  creds: { email: string; password: string; appId: string },
  pageOrigin: string,
) {
  const httpUrl = process.env.CROWDY_HTTP_URL?.trim();
  if (!httpUrl) {
    throw new Error('CONSTRUCT_E2E_SEED_TOKEN=1 requires CROWDY_HTTP_URL');
  }
  const configured = process.env.VITE_CROWDY_HTTP_URL?.trim();
  const bundleOrigin =
    !configured || configured === 'same-origin' || configured === '/' ? pageOrigin : configured;
  const identity = createCrowdyClient({ httpUrl });
  await identity.auth.login({ email: creds.email, password: creds.password });
  const minted = await identity.portal.mintAppToken(creds.appId);
  return {
    token: minted.token,
    handle: envHandleFor(bundleOrigin),
    id: creds.appId,
    route: {
      appId: String(minted.appId ?? creds.appId),
      gameApiUrl: null,
      gameApiWsUrl: null,
      discoveryUrl: null,
      expiresAt: minted.expiresAt,
    },
  };
}

async function writeAppSession(
  page: Page,
  session: Awaited<ReturnType<typeof mintAppSession>>,
): Promise<void> {
  await page.evaluate(({ token, route, handle, id }) => {
    localStorage.setItem(`construct:app-token:${handle}`, token);
    localStorage.setItem(`construct:app-route:${handle}`, JSON.stringify(route));
    localStorage.setItem(`construct:app-id:${handle}`, id);
    localStorage.setItem('construct:env-handle', handle);
  }, session);
}

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
  // CI has no VITE_APP_ID (no-app card). A local .env.local may pin an app
  // (hosted sign-in). Neither path is a password form on this origin.
  await expect(
    page
      .getByRole('button', { name: 'Use this app' })
      .or(page.getByRole('button', { name: 'Sign in with Crowded Kingdoms' })),
  ).toBeVisible();
  await expect(page.getByPlaceholder('••••••••')).toHaveCount(0);
});

test('with an app id, the only sign-in is the hosted one', async ({ page }) => {
  await page.goto('/?app=1');
  await expect(page.getByRole('button', { name: 'Sign in with Crowded Kingdoms' })).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(0);
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
  // Hosted sign-in: the button leaves for Studio's /authorize, which bounces
  // to Studio's /login (email-first, then password), then back here with a
  // code. The credentials are typed into STUDIO, never into this page.
  const signIn = page.getByRole('button', { name: 'Sign in with Crowded Kingdoms' });
  if (await signIn.isVisible()) {
    await signIn.click();
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
          'Hosted sign-in did not complete (Studio login/consent). That is the path this repo demonstrates. Set CONSTRUCT_E2E_SEED_TOKEN=1 and CROWDY_HTTP_URL only for a local stack that cannot show the password form.',
        );
      }
      await page.goto(`/?app=${appId}`);
      const session = await mintAppSession(
        { email: email!, password: password!, appId: appId! },
        new URL(page.url()).origin,
      );
      await writeAppSession(page, session);
      await page.reload();
    }
  }

  await expect(page.getByRole('button', { name: 'Crowdy Studio (M)' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole('button', { name: 'Mic (V)' })).toBeVisible();
  await expect(page.locator('.hud-hint')).toContainText(/WASD|Press E|look/);
  await expect(page.locator('canvas.scene-canvas')).toHaveCount(1);

  // Camera on (Chromium's fake device, see playwright.config.ts): the toggle
  // reads "on", the self-preview appears, and frames leave over the SDK and
  // are accepted — which is the Constructor tier's use_video_chat doing its
  // job. Then off again, releasing the camera. Before the Studio step so it
  // does not depend on a claim's state.
  await page.locator('.chat input').blur();
  await page.getByRole('button', { name: 'Camera (B)' }).click();
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

  // Mic (Chromium fake device): V toggles transmitting.
  await page.keyboard.press('KeyV');
  await expect(page.getByRole('button', { name: 'Mic on (V)' })).toBeVisible({
    timeout: 15_000,
  });
  const voiceState = await page.evaluate(() => {
    const g = (
      window as unknown as {
        __construct?: { session: { voice: { isTransmitting: boolean; error: string | null } } };
      }
    ).__construct;
    return g ? { live: g.session.voice.isTransmitting, error: g.session.voice.error } : null;
  });
  expect(voiceState).toMatchObject({ live: true, error: null });
  await page.keyboard.press('KeyV');
  await expect(page.getByRole('button', { name: 'Mic (V)' })).toBeVisible();

  // RMB-drag look (no pointer lock) and wheel zoom — the public-IP IDE path.
  type Look = { yaw: number; pitch: number; distance: number };
  const lookBefore = await page.evaluate(() => {
    const scene = (
      window as unknown as { __construct?: { router: { current: { lookDebug?: () => Look } } } }
    ).__construct?.router.current;
    return scene?.lookDebug?.() ?? null;
  });
  expect(lookBefore).not.toBeNull();
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, buttons: 2 }));
    window.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 2, movementX: 80, movementY: 0 }),
    );
  });
  await page.waitForTimeout(80);
  const lookAfter = await page.evaluate(() => {
    const scene = (
      window as unknown as { __construct?: { router: { current: { lookDebug?: () => Look } } } }
    ).__construct?.router.current;
    return scene?.lookDebug?.() ?? null;
  });
  expect(lookAfter!.yaw).toBeLessThan(lookBefore!.yaw);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { button: 2, buttons: 0 }));
  });
  await page.locator('canvas.scene-canvas').dispatchEvent('wheel', { deltaY: -400 });
  await page.waitForTimeout(80);
  const lookZoom = await page.evaluate(() => {
    const scene = (
      window as unknown as { __construct?: { router: { current: { lookDebug?: () => Look } } } }
    ).__construct?.router.current;
    return scene?.lookDebug?.() ?? null;
  });
  expect(lookZoom!.distance).toBeLessThan(lookAfter!.distance);

  // T and Enter focus chat. On the Paint pad, Enter must not load the program.
  await page.keyboard.press('KeyT');
  await expect(page.locator('.chat input')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const g = (
      window as unknown as {
        __construct?: { router: { current: { setLocalPosition(p: unknown): void } } };
      }
    ).__construct;
    if (!g) throw new Error('dev handle unavailable');
    g.router.current.setLocalPosition({ x: 10, y: 0, z: -6 });
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.chat input')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __construct?: { router: { current: { id: string } | null } };
            }
          ).__construct?.router.current?.id ?? '',
      ),
    )
    .toBe('holodeck');
  await page.keyboard.press('Escape');
  await expect(page.locator('canvas.scene-canvas')).toHaveCount(1);

  // E on the pad loads Paint; then wheel zoom.
  await page.keyboard.press('KeyE');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __construct?: { router: { current: { id: string } | null } };
            }
          ).__construct?.router.current?.id ?? '',
      ),
    )
    .toBe('paint');
  type Cam = { cellPx: number; panX: number; panZ: number };
  const paintBefore = await page.evaluate(() => {
    const scene = (
      window as unknown as { __construct?: { router: { current: { cameraDebug?: () => Cam } } } }
    ).__construct?.router.current;
    return scene?.cameraDebug?.() ?? null;
  });
  expect(paintBefore).not.toBeNull();
  await page.locator('canvas.scene-canvas').dispatchEvent('wheel', { deltaY: -400 });
  await page.waitForTimeout(80);
  const paintAfter = await page.evaluate(() => {
    const scene = (
      window as unknown as { __construct?: { router: { current: { cameraDebug?: () => Cam } } } }
    ).__construct?.router.current;
    return scene?.cameraDebug?.() ?? null;
  });
  expect(paintAfter!.cellPx).toBeGreaterThan(paintBefore!.cellPx);
  await page.evaluate(async () => {
    const g = (
      window as unknown as { __construct?: { router: { load: (id: string) => Promise<void> } } }
    ).__construct;
    if (!g) throw new Error('dev handle unavailable');
    await g.router.load('holodeck');
  });

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
