/**
 * Security headers for The Construct — used by the Vite dev/preview servers and
 * documented for every hosting recipe in docs/HOSTING.md.
 *
 * Why a game needs these at all: Crowdy Studio CLIENT mods run untrusted player
 * code in a same-origin worker and talk to the page through a SharedArrayBuffer
 * + Atomics bridge. Browsers only expose SharedArrayBuffer to pages that are
 * cross-origin isolated, which takes BOTH `Cross-Origin-Opener-Policy` and
 * `Cross-Origin-Embedder-Policy`. Without them `crossOriginIsolated` is false,
 * the worker cannot start, and the feature silently disappears. The CSP is the
 * other half: it keeps the worker same-origin and the page's network reach
 * limited to the API it was built for.
 *
 * The API origin moves at runtime: the shared client origin hands the client
 * to the app's datacenter and then to a direct API instance, all under the
 * same one-label zone (e.g. `ck.<tier>.example` -> `*.<tier>.example`). The
 * connect-src therefore admits the configured origin plus that one-label
 * wildcard, and nothing wider.
 */

function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * `https://ck.prod.example.com` -> `https://*.prod.example.com` (and the wss:
 * twin). Nothing for hosts with no parent zone (localhost, IPs).
 */
export function tierZoneWildcards(origins) {
  const out = [];
  for (const origin of origins) {
    if (!origin) continue;
    let url;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    const labels = url.hostname.split('.');
    if (labels.length < 3) continue;
    if (/^[\d.]+$/.test(url.hostname)) continue;
    const zone = labels.slice(1).join('.');
    out.push(`https://*.${zone}`, `wss://*.${zone}`);
  }
  return out;
}

/**
 * Build the Content-Security-Policy for the page and its same-origin workers.
 *
 * @param {{ apiOrigins?: Array<string | null | undefined>, extraConnectSrc?: string[] }} options
 *   `apiOrigins` — every API origin the bundle may dial (the configured one, or
 *   the SDK default). `extraConnectSrc` — additional exact origins a fork needs
 *   (analytics beacon, its own backend). Keep this list exact; no `*`.
 */
export function buildCsp({ apiOrigins = [], extraConnectSrc = [] } = {}) {
  const configured = apiOrigins.map(originOf);
  const wsTwins = configured
    .filter(Boolean)
    .map((origin) => origin.replace(/^http(s?):/, (_, secure) => `ws${secure}:`));
  const connectSources = unique([
    "'self'",
    ...configured,
    ...wsTwins,
    ...tierZoneWildcards(configured),
    ...extraConnectSrc,
  ]);

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // 'wasm-unsafe-eval' lets the SDK instantiate WebAssembly (the Rust
    // language worker and the player-mod runtime). It grants no JS eval.
    "script-src 'self' 'wasm-unsafe-eval'",
    // Monaco injects computed styles; three.js/pixi do not need this but the
    // editor does.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    // The glue worker and Monaco workers are same-origin module workers; blob:
    // covers Vite's dev-mode worker wrappers.
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "media-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

/**
 * The full header set. Apply to every response of the site (HTML, JS, worker
 * scripts, wasm), not just index.html — a worker fetched without COEP breaks
 * isolation for the page that spawned it.
 */
export function securityHeaders(options = {}) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    // `credentialless` rather than `require-corp`: it lets the page load
    // cross-origin subresources without CORP headers by stripping credentials,
    // which is what a static game on a CDN needs. Both values enable isolation.
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': buildCsp(options),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

/** The two headers that decide `crossOriginIsolated`; listed for docs/tests. */
export const ISOLATION_HEADERS = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'];
