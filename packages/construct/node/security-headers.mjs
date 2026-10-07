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
export function buildCsp({ apiOrigins = [], extraConnectSrc = [], frameAncestors = [] } = {}) {
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
    // 'none' when self-hosted at the top level. When this game is FRAMED -- by the
    // Crowdy Games shell (which the platform's content edge sets for you), or by a
    // shell of your own -- name exactly that origin here (`frameAncestors`); a game
    // that can be framed anywhere is a clickjacking surface.
    `frame-ancestors ${frameAncestorsSource(frameAncestors)}`,
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
    // 'self' lets Crowdy Studio embed the same-origin in-browser DeepSeek Harness (/dsh/).
    "frame-src 'self'",
    "media-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

/**
 * Build the Content-Security-Policy for the in-browser DeepSeek Harness (/dsh/*).
 * The harness worker loads lowered module bodies with `new Function` and runs its
 * own module system; its iframe is embedded by the game page ('self').
 */
export function buildDshCsp({ apiOrigins = [], extraConnectSrc = [], frameAncestors = [] } = {}) {
  const configured = apiOrigins.map(originOf);
  const wsTwins = configured
    .filter(Boolean)
    .map((origin) => origin.replace(/^http(s?):/, (_, secure) => `ws${secure}:`));
  const connectSources = unique([
    "'self'",
    'blob:',
    ...configured,
    ...wsTwins,
    ...tierZoneWildcards(configured),
    ...extraConnectSrc,
  ]);

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    // 'self' (the game page frames the pane) PLUS whoever frames the game: frame-ancestors
    // is checked against EVERY ancestor, so under the Crowdy Games shell the pane's
    // ancestors are the game and the shell, and 'self' alone would refuse it.
    `frame-ancestors 'self'${frameAncestors.length ? ` ${frameAncestorsSource(frameAncestors)}` : ''}`,
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "media-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

/**
 * Build the Content-Security-Policy for the JS grid program sandbox
 * (`/grid-program.html`, framed by the game in `sandbox="allow-scripts"`).
 * The program's code arrives as a blob module; it gets NO network at all
 * (`connect-src 'none'`): everything it does crosses the MessagePort to the
 * page, which relays it with a grid-scoped token (DN-10). No inline script,
 * no eval, no workers, no frames, no forms.
 */
export function buildGridProgramCsp() {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "script-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
  ].join('; ');
}

/** `frameAncestors` -> a CSP source list; `'none'` when nothing may frame the page. */
export function frameAncestorsSource(frameAncestors = []) {
  const origins = unique(frameAncestors.map(originOf));
  return origins.length ? origins.join(' ') : "'none'";
}

/** `same-origin` unless somebody may frame the game, then `cross-origin` (see securityHeaders). */
export function corpFor({ frameAncestors = [] } = {}) {
  return frameAncestors.some((a) => originOf(a)) ? 'cross-origin' : 'same-origin';
}

/** Which powerful features the page (and only the page) may use. */
export const PERMISSIONS_POLICY = 'camera=(self), microphone=(self)';

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
    // `same-origin` for a top-level game. A FRAMED game must say `cross-origin`:
    // browsers enforce CORP on nested navigations too, so under the shell's COEP a
    // `same-origin` document is refused with ERR_BLOCKED_BY_RESPONSE before
    // frame-ancestors is even consulted. Measured 2026-09-13 in the shell e2e.
    'Cross-Origin-Resource-Policy': corpFor(options),
    'Content-Security-Policy': buildCsp(options),
    // The page may use the camera and microphone (WebcamService / VoiceService);
    // nothing embedded may. An explicit policy also stops a hosting default
    // from silently denying either device.
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * Security headers for the in-browser DeepSeek Harness surface (/dsh/*).
 */
export function dshSecurityHeaders(options = {}) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': corpFor(options),
    'Content-Security-Policy': buildDshCsp(options),
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * Security headers for the JS grid program sandbox page. Same isolation as the
 * game (a cross-origin-isolated page can only frame COEP documents), its own
 * CSP, and no powerful features.
 */
export function gridProgramSecurityHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': buildGridProgramCsp(),
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

/** The two headers that decide `crossOriginIsolated`; listed for docs/tests. */
export const ISOLATION_HEADERS = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'];
