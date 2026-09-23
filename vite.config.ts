import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv, type Plugin } from 'vite';

import { constructDevServerOptions, envFlag } from './scripts/lib/dev-server-options.mjs';
import { sdkDefaultHttpOrigin } from './scripts/lib/sdk-default-origin.mjs';
import { constructHeaderPlugins } from '@crowdedkingdoms/construct/node/vite-plugins';

import {
  dshSecurityHeaders,
  gridProgramSecurityHeaders,
  securityHeaders,
} from './security-headers.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Same-origin door to the local Buddy stand-in. Page CSP connect-src is only 'self'. */
function localBuddyProxy(): Plugin {
  const forward: Plugin['configureServer'] = (server) => {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';
      if (!url.startsWith('/local-buddy')) {
        next();
        return;
      }
      const targetPath = url.slice('/local-buddy'.length) || '/';
      const headers = { ...req.headers, host: '127.0.0.1:8787' };
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: 8787,
          path: targetPath,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('local buddy unavailable');
      });
      req.pipe(proxyReq);
    });
  };
  return { name: 'construct-local-buddy', configureServer: forward };
}

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

  return {
    plugins: [
      localBuddyProxy(),
      ...constructHeaderPlugins({
        dshHeaders,
        gridProgramHeaders: gridProgramSecurityHeaders(),
      }),
    ],
    resolve: {
      alias: { '@': path.resolve(rootDir, 'src') },
    },
    server: {
      port: 5175,
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
