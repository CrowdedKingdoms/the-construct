import { defineConfig } from '@playwright/test';

/**
 * Browser smoke against `vite preview` (the production bundle with the real
 * security headers). Two tiers of assertions:
 *   - always: the page boots cross-origin isolated and shows sign-in;
 *   - with CONSTRUCT_E2E=1 + CONSTRUCT_EMAIL/PASSWORD/APP_ID: signs in, enters
 *     the app, joins the holodeck and opens Crowdy Studio on a claimed chunk.
 * The live half needs a real account and app, so CI runs only the first tier.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.CONSTRUCT_E2E_URL ?? 'http://127.0.0.1:4175',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // A synthetic camera so the live test can turn the webcam on without a
    // device or a permission prompt (Chromium's test pattern, 128x96 capture).
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    permissions: ['camera', 'microphone'],
  },
  webServer: process.env.CONSTRUCT_E2E_URL
    ? undefined
    : {
        command: 'npm run build && npx vite preview --port 4175 --strictPort',
        url: 'http://127.0.0.1:4175',
        reuseExistingServer: true,
        timeout: 240_000,
      },
});
