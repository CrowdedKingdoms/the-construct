import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv } from 'vite';

import { sdkDefaultHttpOrigin } from './scripts/lib/sdk-default-origin.mjs';
import { securityHeaders } from './security-headers.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  // The CSP must admit whichever API the bundle will actually dial: an explicit
  // override, or the origin baked into the installed SDK for its tier.
  const apiOrigin = env.VITE_CROWDY_HTTP_URL?.trim() || sdkDefaultHttpOrigin(rootDir);
  const headers = securityHeaders({ apiOrigins: [apiOrigin] });

  return {
    resolve: {
      alias: { '@': path.resolve(rootDir, 'src') },
    },
    server: {
      port: 5175,
      host: true,
      allowedHosts: true,
      // IDE browser cannot call :3000 from this page (CSP connect-src is
      // enforced against a rewritten request URL). Same-origin /graphql and
      // /realtime go to ck-api on loopback instead.
      proxy: {
        '/graphql': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
        '/realtime': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
      },
      // Isolation headers are correct on HTTPS / localhost. On this builder the
      // IDE browser hits http://PUBLIC_IP:5175, which is not a secure context:
      // COEP credentialless then blocks fetch() to ck-api (Failed to fetch) and
      // the page never signs in. Omit COEP/COOP here so the holodeck can load;
      // CLIENT mods stay off (crossOriginIsolated is false on plain HTTP).
      headers: Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) =>
            name !== 'Cross-Origin-Embedder-Policy' && name !== 'Cross-Origin-Opener-Policy',
        ),
      ),
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
