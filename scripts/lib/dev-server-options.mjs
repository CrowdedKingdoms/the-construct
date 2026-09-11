/**
 * Optional Vite *dev-server* extras. Defaults are a public template: isolation
 * headers, no proxy, no allowedHosts wildcard. Local ck-api / IDE-on-public-IP
 * stacks opt in via VITE_DEV_* (see .env.example). Preview/production never
 * use these flags.
 */

const ISOLATION_HEADERS = new Set(['Cross-Origin-Embedder-Policy', 'Cross-Origin-Opener-Policy']);

export function envFlag(env, name) {
  const raw = env?.[name]?.trim();
  if (!raw) return false;
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

export function stripIsolationHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !ISOLATION_HEADERS.has(name)),
  );
}

/**
 * @param {{
 *   proxy?: boolean;
 *   relaxIsolation?: boolean;
 *   allowAllHosts?: boolean;
 *   proxyTarget?: string;
 *   headers: Record<string, string>;
 * }} input
 */
export function constructDevServerOptions(input) {
  const proxyTarget = input.proxyTarget?.trim() || 'http://127.0.0.1:3000';
  return {
    ...(input.allowAllHosts ? { allowedHosts: true } : {}),
    ...(input.proxy
      ? {
          proxy: {
            '/graphql': { target: proxyTarget, changeOrigin: true, ws: true },
            '/realtime': { target: proxyTarget, changeOrigin: true, ws: true },
          },
        }
      : {}),
    headers: input.relaxIsolation ? stripIsolationHeaders(input.headers) : input.headers,
  };
}
