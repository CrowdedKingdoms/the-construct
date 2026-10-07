/**
 * Vite plugins every Construct game needs: path-scoped security headers for
 * the two same-origin pages the game frames, the in-browser DeepSeek Harness
 * (`/dsh/*`) and the JS grid program sandbox (`/grid-program.html`). The site
 * headers (securityHeaders) are applied by Vite's `server.headers`; these
 * override them for their own paths.
 */

/**
 * @param {string} name
 * @param {(pathname: string) => boolean} match
 * @param {Record<string, string>} headers
 * @param {{ keepGzipArchives?: boolean }} [options]
 */
function pathHeadersPlugin(name, match, headers, options = {}) {
  /** @param {import('vite').ViteDevServer | import('vite').PreviewServer} server */
  const attach = (server) => {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? '').split('?')[0] ?? '';
      if (match(pathname)) {
        // The harness's packed VFS image is a .tar.gz its worker inflates with
        // DecompressionStream. Vite's static server adds `Content-Encoding: gzip`
        // for that suffix, so the browser would inflate it first and the worker
        // would then fail on plain tar. Only that suffix is affected.
        const isGzipArchive = options.keepGzipArchives && /\.gz$/i.test(pathname);
        const origSetHeader = res.setHeader.bind(res);
        res.setHeader = (header, value) => {
          if (isGzipArchive && header.toLowerCase() === 'content-encoding') return res;
          const pinned = headers[header];
          return origSetHeader(header, pinned !== undefined ? pinned : value);
        };
        for (const [header, value] of Object.entries(headers)) origSetHeader(header, value);
      }
      next();
    });
  };
  return { name, configureServer: attach, configurePreviewServer: attach };
}

/**
 * The grid program sandbox is an OPAQUE origin (`sandbox="allow-scripts"`
 * without allow-same-origin), so its module scripts are fetched in CORS mode
 * with `Origin: null`. Answer those, and only those, with
 * `Access-Control-Allow-Origin: null`. The API paths are left alone: the
 * sandbox has `connect-src 'none'` and reaches the API only through the page.
 * The files served this way are the game's public bundle.
 */
function sandboxModuleCorsPlugin() {
  /** @param {import('vite').ViteDevServer | import('vite').PreviewServer} server */
  const attach = (server) => {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? '').split('?')[0] ?? '';
      const isApi = /^\/(graphql|realtime|s2s|api)(\/|$)/.test(pathname);
      if (req.headers.origin === 'null' && req.method === 'GET' && !isApi) {
        const origSetHeader = res.setHeader.bind(res);
        res.setHeader = (header, value) =>
          header.toLowerCase() === 'access-control-allow-origin'
            ? origSetHeader(header, 'null')
            : origSetHeader(header, value);
        origSetHeader('Access-Control-Allow-Origin', 'null');
        origSetHeader('Vary', 'Origin');
      }
      next();
    });
  };
  return {
    name: 'construct-grid-program-module-cors',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

/**
 * Omit `dshHeaders` when the game already serves `/dsh/*` under its own policy.
 *
 * @param {{ dshHeaders?: Record<string, string>, gridProgramHeaders?: Record<string, string> }} options
 * @returns {import('vite').Plugin[]}
 */
export function constructHeaderPlugins({ dshHeaders, gridProgramHeaders }) {
  const plugins = [];
  if (dshHeaders) {
    plugins.push(
      pathHeadersPlugin(
        'construct-dsh-headers',
        (p) => p.startsWith('/dsh/') || p === '/dsh',
        dshHeaders,
        { keepGzipArchives: true },
      ),
    );
  }
  if (gridProgramHeaders) {
    plugins.push(
      sandboxModuleCorsPlugin(),
      pathHeadersPlugin(
        'construct-grid-program-headers',
        (p) => p.endsWith('/grid-program.html'),
        gridProgramHeaders,
      ),
    );
  }
  return plugins;
}
