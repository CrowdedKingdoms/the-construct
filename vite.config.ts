import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv } from 'vite';

import { constructDevServerOptions, envFlag } from './scripts/lib/dev-server-options.mjs';
import { sdkDefaultHttpOrigin } from './scripts/lib/sdk-default-origin.mjs';
import { constructHeaderPlugins } from '@crowdedkingdoms/construct/node/vite-plugins';
import { liveDraftPlugin } from './scripts/lib/live-draft.mjs';

import {
  dshSecurityHeaders,
  gridProgramSecurityHeaders,
  securityHeaders,
} from './security-headers.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  // The CSP must admit whichever API the bundle will actually dial: an explicit
  // override, or the origin baked into the installed SDK for its tier.
  const apiOrigin = env.VITE_CROWDY_HTTP_URL?.trim() || sdkDefaultHttpOrigin(rootDir);
  // Who may FRAME this game. Empty (the default) means nobody: a self-hosted game is a
  // top-level page. The shell e2e (tests/e2e/shell.spec.ts) sets it to its fixture's
  // origin; a fork that runs behind a shell of its own sets it to that origin. On
  // Crowdy Games the platform's edge serves the equivalent and this is not read.
  const frameAncestors = (env.CONSTRUCT_FRAME_ANCESTORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const headers = securityHeaders({ apiOrigins: [apiOrigin], frameAncestors });
  const dshHeaders = dshSecurityHeaders({ apiOrigins: [apiOrigin], frameAncestors });
  // Checkout of the bound game. Draft writes land there and Vite serves its
  // scenes and catalog, so a draft updates this page before a GitHub commit.
  const draftRoot = env.LIVE_DRAFT_ROOT?.trim();

  return {
    plugins: [
      ...constructHeaderPlugins({
        dshHeaders,
        gridProgramHeaders: gridProgramSecurityHeaders(),
      }),
      ...(draftRoot ? [liveDraftPlugin(draftRoot)] : []),
    ],
    resolve: {
      alias: [
        ...(draftRoot
          ? [{ find: '@/scenes', replacement: path.resolve(draftRoot, 'src/scenes') }]
          : []),
        { find: '@', replacement: path.resolve(rootDir, 'src') },
      ],
    },
    server: {
      port: 5175,
      strictPort: true,
      host: true,
      // Default: production isolation, no proxy. Local stacks opt in via
      // VITE_DEV_PROXY / VITE_DEV_ALLOWED_HOSTS / VITE_DEV_RELAX_ISOLATION.
      ...constructDevServerOptions({
        headers,
        proxy: envFlag(env, 'VITE_DEV_PROXY'),
        allowAllHosts: envFlag(env, 'VITE_DEV_ALLOWED_HOSTS'),
        relaxIsolation: envFlag(env, 'VITE_DEV_RELAX_ISOLATION'),
        proxyTarget: env.VITE_DEV_PROXY_TARGET?.trim(),
      }),
      fs: {
        allow: [rootDir, ...(draftRoot ? [path.resolve(draftRoot)] : [])],
      },
      // A machine that is already out of inotify watches can still serve the
      // draft. Polling is opt-in so a normal checkout keeps native watches.
      ...(env.VITE_DEV_POLL === '1' ? { watch: { usePolling: true, interval: 300 } } : {}),
    },
    preview: {
      headers,
    },
    worker: {
      // The Studio language worker code-splits; iife workers cannot.
      format: 'es',
    },
    optimizeDeps: {
      // Pre-bundling would inline the SDK into .vite/deps and break the
      // `new Worker(new URL(...), import.meta.url)` URLs of the Crowdy Studio
      // Monaco/language workers in dev. The @codingame pair must also stay
      // un-bundled so the VS Code service overrides register against the same
      // module instance the editor API reads from.
      exclude: [
        '@crowdedkingdoms/crowdyjs',
        '@codingame/monaco-vscode-editor-api',
        '@codingame/monaco-vscode-api',
      ],
      // CommonJS deps of the excluded SDK still need esbuild interop in dev.
      include: [
        '@crowdedkingdoms/crowdyjs > vscode-jsonrpc',
        '@crowdedkingdoms/crowdyjs > vscode-languageserver-protocol',
        '@crowdedkingdoms/crowdyjs > vscode-languageserver-types',
      ],
    },
    build: {
      target: 'ES2022',
      // Source maps triple the output size (Monaco); opt in when debugging a build.
      sourcemap: env.VITE_SOURCEMAP === '1',
      // The Crowdy Studio editor is one large, lazily loaded chunk; that is the
      // SDK's shape, not a bundling mistake.
      chunkSizeWarningLimit: 5000,
      rollupOptions: {
        // The JS grid program sandbox is its own page (framed by the game).
        input: {
          main: path.resolve(rootDir, 'index.html'),
          gridProgram: path.resolve(rootDir, 'grid-program.html'),
        },
      },
    },
  };
});
