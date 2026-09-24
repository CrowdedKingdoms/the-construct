import { createCrowdyClient } from '@crowdedkingdoms/crowdyjs';
import { expect, test, type Page } from '@playwright/test';

/**
 * JS grid programs (DN-10): a player's JavaScript runs in their own grid, in a
 * network-less sandbox, with the full CrowdyJS SDK relayed through a
 * grid-scoped token. The program speaks from inside the grid, and a send whose
 * origin is outside the grid is refused.
 *
 * Needs the dev handle (`window.__construct`), so it runs against `vite dev`:
 *
 *   CONSTRUCT_E2E=1 CONSTRUCT_E2E_URL=http://localhost:5175 CROWDY_HTTP_URL=http://127.0.0.1:3000 \
 *   CONSTRUCT_EMAIL=… CONSTRUCT_PASSWORD=… APP_ID=… CONSTRUCT_E2E_GRID=<gridId the player owns> \
 *     npx playwright test tests/e2e/grid-program.spec.ts
 */
const live = process.env.CONSTRUCT_E2E === '1';
const email = process.env.CONSTRUCT_EMAIL;
const password = process.env.CONSTRUCT_PASSWORD;
const appId = process.env.APP_ID ?? process.env.VITE_APP_ID;
const gridId = process.env.CONSTRUCT_E2E_GRID;
const httpUrl = process.env.CROWDY_HTTP_URL?.trim();

function envHandleFor(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  return `${url.hostname}${url.port ? `_${url.port}` : ''}`;
}

/** The API origin the page dials: an explicit override, or the page itself (dev proxy). */
function pageApiOrigin(page: Page): string {
  const configured = process.env.VITE_CROWDY_HTTP_URL?.trim() ?? 'same-origin';
  if (configured === 'same-origin' || configured === '/') return new URL(page.url()).origin;
  return configured;
}

async function seedSession(page: Page): Promise<void> {
  const identity = createCrowdyClient({ httpUrl: httpUrl!, embeddedHost: false });
  await identity.auth.login({ email: email!, password: password! });
  const minted = await identity.portal.mintAppToken(appId!);
  await page.evaluate(
    ({ token, handle, id, expiresAt }) => {
      localStorage.setItem(`construct:app-token:${handle}`, token);
      localStorage.setItem(
        `construct:app-route:${handle}`,
        JSON.stringify({
          appId: id,
          gameApiUrl: null,
          gameApiWsUrl: null,
          discoveryUrl: null,
          expiresAt,
        }),
      );
      localStorage.setItem(`construct:app-id:${handle}`, id);
      localStorage.setItem('construct:env-handle', handle);
    },
    {
      token: minted.token,
      handle: envHandleFor(pageApiOrigin(page)),
      id: appId!,
      expiresAt: minted.expiresAt,
    },
  );
}

const PROGRAM = `
export default async function ({ grid, box, log }) {
  log('hello from grid ' + grid.gridId);
  const uuid = 'e'.repeat(32);
  const inside = { x: String(box.low.x), y: String(box.low.y), z: String(box.low.z) };
  await grid.send.text({ chunk: inside, uuid, text: 'inside', distance: 1 });
  log('sent from inside');
  const channels = await grid.channels.list();
  log('grid channels: ' + channels.length);
  try {
    await grid.send.text({ chunk: { x: String(box.high.x + 1n), y: inside.y, z: inside.z }, uuid, text: 'outside' });
    log('UNEXPECTED: outside send accepted');
  } catch (error) {
    log('outside refused: ' + error.name);
  }
}
`;

test('a JS grid program runs with CrowdyJS inside its grid and cannot send from outside it', async ({
  page,
}) => {
  test.skip(
    !live || !email || !password || !appId || !gridId || !httpUrl,
    'set CONSTRUCT_E2E=1 CONSTRUCT_E2E_URL CROWDY_HTTP_URL CONSTRUCT_EMAIL CONSTRUCT_PASSWORD APP_ID CONSTRUCT_E2E_GRID',
  );
  test.setTimeout(120_000);
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.goto(`/?app=${appId}`);
  await seedSession(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Crowdy Studio (M)' })).toBeVisible({
    timeout: 90_000,
  });

  const first = await page.evaluate(
    async ({ gridId, source }) => {
      const handle = (
        window as unknown as {
          __construct: {
            session: { studio: { programs: { runProgram: (i: unknown) => Promise<unknown> } } };
          };
        }
      ).__construct;
      return handle.session.studio.programs.runProgram({ gridId, path: 'programs/e2e.js', source });
    },
    { gridId: gridId!, source: PROGRAM },
  );
  expect(first).toMatchObject({ path: 'programs/e2e.js' });

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const handle = (
            window as unknown as {
              __construct: {
                session: { studio: { programs: { programs: () => Array<{ log: string[] }> } } };
              };
            }
          ).__construct;
          return handle.session.studio.programs.programs()[0]?.log.join('\n') ?? '';
        }),
      { timeout: 30_000 },
    )
    .toMatch(/outside refused: GridScopeError/);

  const status = await page.evaluate(() => {
    const handle = (
      window as unknown as {
        __construct: {
          session: {
            studio: {
              programs: {
                programs: () => Array<{ running: boolean; log: string[]; lastError?: string }>;
              };
            };
          };
        };
      }
    ).__construct;
    return handle.session.studio.programs.programs()[0];
  });
  expect(status?.running).toBe(true);
  expect(status?.lastError).toBeUndefined();
  expect(status?.log.join('\n')).toContain(`hello from grid ${gridId}`);
  expect(status?.log.join('\n')).toContain('sent from inside');
  expect(status?.log.join('\n')).not.toContain('UNEXPECTED');
});
