import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * The game FRAMED by a Crowdy Games shell -- the arrangement a published game runs in
 * (`npm run publish`). Two things must hold, and neither is visible from the smoke
 * test against the top-level preview:
 *
 *   1. Inside the frame the game is still cross-origin isolated (CLIENT mods need
 *      it). That takes COOP + COEP on the SHELL document too, and a `frame-ancestors`
 *      on the game that admits the shell.
 *   2. Hosted sign-in goes THROUGH the shell: the SDK asks the shell to navigate
 *      (`crowdyjs:navigate`) to the shell's Studio `/authorize` with the SHELL page as
 *      `redirect_uri`, rather than navigating the frame itself.
 *
 * The fixture (`tests/e2e/fixtures/shell.*`) is a stand-in for Crowdy-Games `shell/`
 * speaking protocol v1; it records navigate requests instead of performing them. The
 * game is a second `vite preview` of the same build with
 * `CONSTRUCT_FRAME_ANCESTORS` set to the fixture's origin -- the header the platform's
 * content edge would serve. Skipped when CONSTRUCT_E2E_URL points at a live server.
 */
const SHELL_PORT = 4176;
const GAME_PORT = 4177;
const SHELL_ORIGIN = `http://127.0.0.1:${SHELL_PORT}`;
const GAME_ORIGIN = `http://127.0.0.1:${GAME_PORT}`;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let shell: Server | undefined;
let game: ChildProcess | undefined;

test.describe('framed by the Crowdy Games shell', () => {
  test.skip(!!process.env.CONSTRUCT_E2E_URL, 'the shell fixture needs the local preview');

  test.beforeAll(async () => {
    shell = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', SHELL_ORIGIN);
      const file = url.pathname.endsWith('.js') ? 'shell.js' : 'shell.html';
      const body = await readFile(path.join(rootDir, 'tests/e2e/fixtures', file));
      res.writeHead(200, {
        'content-type': file.endsWith('.js')
          ? 'application/javascript'
          : 'text/html; charset=utf-8',
        // What the games host serves on every shell response.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'credentialless',
        'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${GAME_ORIGIN}; frame-ancestors 'none'`,
        // cross-origin-isolated is a permissions-policy FEATURE: a cross-origin frame
        // reports crossOriginIsolated=false unless the top level delegates it, however
        // correct its own COEP is. The shell delegates it in the header and the iframe's
        // allow attribute; so does this fixture.
        'permissions-policy': `camera=(self "${GAME_ORIGIN}"), microphone=(self "${GAME_ORIGIN}"), cross-origin-isolated=(self "${GAME_ORIGIN}")`,
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => shell!.listen(SHELL_PORT, '127.0.0.1', resolve));

    game = spawn('npx', ['vite', 'preview', '--port', String(GAME_PORT), '--strictPort'], {
      cwd: rootDir,
      env: { ...process.env, CONSTRUCT_FRAME_ANCESTORS: SHELL_ORIGIN },
      stdio: 'ignore',
    });
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${GAME_ORIGIN}/`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(200);
  });

  test.afterAll(async () => {
    game?.kill();
    await new Promise<void>((resolve) => (shell ? shell.close(() => resolve()) : resolve()));
  });

  test('the framed game is served frame-ancestors = the shell, and the DSH pane admits both', async () => {
    const page = await fetch(`${GAME_ORIGIN}/`);
    expect(page.headers.get('content-security-policy')).toContain(
      `frame-ancestors ${SHELL_ORIGIN}`,
    );
    expect(page.headers.get('content-security-policy')).not.toContain("frame-ancestors 'none'");
    expect(page.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    const dsh = await fetch(`${GAME_ORIGIN}/dsh/index.html`);
    expect(dsh.headers.get('content-security-policy')).toContain(
      `frame-ancestors 'self' ${SHELL_ORIGIN}`,
    );
  });

  test('inside the shell the game boots cross-origin isolated', async ({ page }) => {
    await page.goto(`${SHELL_ORIGIN}/?game=${encodeURIComponent(GAME_ORIGIN)}&app=1`);
    const frame = page.frameLocator('#game');
    await expect(frame.getByRole('button', { name: 'Sign in with Crowded Kingdoms' })).toBeVisible({
      timeout: 60_000,
    });
    const gameFrame = page.frame({ url: (u) => u.origin === GAME_ORIGIN });
    expect(gameFrame).toBeTruthy();
    await expect.poll(() => gameFrame!.evaluate(() => crossOriginIsolated)).toBe(true);
    // And the shell itself is isolated too (a prerequisite for the frame).
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  test('hosted sign-in asks the shell to navigate to Studio with the shell page as redirect_uri', async ({
    page,
  }) => {
    // The bridge is CrowdyJS >= 17.2 (`EmbeddedHost`). On an older pin the game
    // navigates its own frame (which the sandbox blocks) and no request reaches the
    // shell -- a pin problem, not a regression, so say so rather than fail.
    const sdk = (await import('@crowdedkingdoms/crowdyjs')) as Record<string, unknown>;
    test.skip(
      typeof sdk.EmbeddedHost !== 'function',
      'installed CrowdyJS has no EmbeddedHost bridge (pin < 17.2)',
    );
    await page.goto(`${SHELL_ORIGIN}/?game=${encodeURIComponent(GAME_ORIGIN)}&app=1`);
    const frame = page.frameLocator('#game');
    const button = frame.getByRole('button', { name: 'Sign in with Crowded Kingdoms' });
    await expect(button).toBeVisible({ timeout: 60_000 });
    await button.click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __navigateRequests?: string[] }).__navigateRequests?.length ??
              0,
          ),
        {
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0);
    const requested = await page.evaluate(
      () => (window as unknown as { __navigateRequests: string[] }).__navigateRequests[0],
    );
    expect(requested).toBeTruthy();
    const url = new URL(requested as string);
    // The build under test passes VITE_AUTHORIZE_URL explicitly (a local API has no
    // derivable Studio), and an explicit authorizeUrl wins over the shell's origin; a
    // game on a CK tier leaves it unset and gets the shell's Studio. Either way the
    // path is /authorize and the return leg is the SHELL page.
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(`${SHELL_ORIGIN}/`);
    expect(url.searchParams.get('app_id')).toBe('1');
    expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(20);
    // The frame did NOT navigate itself, and the tab is still the shell.
    expect(page.url().startsWith(SHELL_ORIGIN)).toBe(true);
    const gameFrame = page.frame({ url: (u) => u.origin === GAME_ORIGIN });
    expect(gameFrame).toBeTruthy();
  });
});
