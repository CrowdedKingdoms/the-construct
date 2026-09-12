import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OutgoingHttpHeader } from 'node:http';

import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';

import { constructDevServerOptions, envFlag } from './scripts/lib/dev-server-options.mjs';
import { sdkDefaultHttpOrigin } from './scripts/lib/sdk-default-origin.mjs';
import { dshSecurityHeaders, securityHeaders } from './security-headers.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function dshHeadersPlugin(dshHeaders: Record<string, string>): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (req.url && (req.url.startsWith('/dsh/') || req.url === '/dsh')) {
        // The packed VFS image is a .tar.gz the harness worker decompresses
        // itself with DecompressionStream. Vite's static server sees the .gz
        // suffix and adds `Content-Encoding: gzip`, so the browser would
        // inflate it first and the worker would then fail on plain tar. Only
        // that suffix is affected; every other /dsh/* response keeps whatever
        // encoding the server negotiated (stripping it from a compressed JS
        // response corrupts the body under `vite preview`).
        const pathname = req.url.split('?')[0] ?? '';
        const isGzipArchive = /\.gz$/i.test(pathname);
        const origSetHeader = res.setHeader.bind(res);
        res.setHeader = (name: string, value: OutgoingHttpHeader) => {
          if (isGzipArchive && name.toLowerCase() === 'content-encoding') {
            return res;
          }
          const pinned = dshHeaders[name];
          if (pinned !== undefined) {
            return origSetHeader(name, pinned);
          }
          return origSetHeader(name, value);
        };
        for (const [name, value] of Object.entries(dshHeaders)) {
          origSetHeader(name, value);
        }
      }
      next();
    });
  };
  return {
    name: 'construct-dsh-headers',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  // The CSP must admit whichever API the bundle will actually dial: an explicit
  // override, or the origin baked into the installed SDK for its tier.
  const apiOrigin = env.VITE_CROWDY_HTTP_URL?.trim() || sdkDefaultHttpOrigin(rootDir);
  const headers = securityHeaders({ apiOrigins: [apiOrigin] });
  const dshHeaders = dshSecurityHeaders({ apiOrigins: [apiOrigin] });

  return {
    plugins: [dshHeadersPlugin(dshHeaders)],
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
    },
  };
});
