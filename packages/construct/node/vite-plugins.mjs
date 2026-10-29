/**
 * Vite plugins every Construct game needs: path-scoped security headers for
 * the two same-origin pages the game frames, the in-browser DeepSeek Harness
 * (`/dsh/*`) and the JS grid program sandbox (`/grid-program.html`), and the
 * hosted preview of Crowdy Studio's game editor (`constructDraftPlugin`). The
 * site headers (securityHeaders) are applied by Vite's `server.headers`; the
 * header plugins override them for their own paths.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} name
 * @param {(pathname: string) => boolean} match
 * @param {Record<string, string>} headers
 * @param {{ keepGzipArchives?: boolean }} [options]
 */
function pathHeadersPlugin(name, match, headers, options = {}) {
  /** @param {import('vite').ViteDevServer | import('vite').PreviewServer} server */
  const attach = (server) => {
    // Matched against the path under the game's base, so `vite build --base /game/`
    // previews `/game/dsh/` with the harness's headers.
    const base = server.config?.base ?? '/';
    server.middlewares.use((req, res, next) => {
      const raw = (req.url ?? '').split('?')[0] ?? '';
      const pathname = base !== '/' && raw.startsWith(base) ? `/${raw.slice(base.length)}` : raw;
      if (match(pathname)) {
        // The harness's packed VFS image is a .tar.gz its worker inflates with
        // DecompressionStream. Vite's static server adds `Content-Encoding: gzip`
        // for that suffix, so the browser would inflate it first and the worker
        // would then fail on plain tar. Only that suffix is affected.
        const isGzipArchive = options.keepGzipArchives && /\.gz$/i.test(pathname);
        const origSetHeader = res.setHeader.bind(res);
        res.setHeader = (header, value) => {
          const lower = header.toLowerCase();
          if (isGzipArchive && lower === 'content-encoding') return res;
          // Its own type, so `vite preview`'s compression (which takes an untyped body
          // for text/plain) leaves the archive alone instead of gzipping it twice.
          if (isGzipArchive && lower === 'content-type')
            return origSetHeader(header, 'application/gzip');
          const pinned = headers[header];
          return origSetHeader(header, pinned !== undefined ? pinned : value);
        };
        for (const [header, value] of Object.entries(headers)) origSetHeader(header, value);
        if (isGzipArchive) origSetHeader('Content-Type', 'application/gzip');
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

const DRAFT_HOST_MODULES = 'virtual:construct-draft-host';
const DRAFT_WORKER_FILE = 'construct-draft-sw.js';
const FRAMEWORK = '@crowdedkingdoms/construct';
const FRAMEWORK_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const DRAFT_WORKER_ENTRY = fileURLToPath(
  new URL('../src/platform/live/draftServiceWorker.ts', import.meta.url),
);
/**
 * The game editor's own machinery (the loader, the worker, the transform, the
 * dev-server store) is not for drafts; `platform/live/content` is the contract
 * a game's content imports.
 */
const forDrafts = (rel) => !rel.startsWith('platform/live/') || rel === 'platform/live/content';
const SOURCE_FILE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|js|mjs)$/;

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

/** Every public framework module, as the specifier a game writes. */
async function frameworkModules() {
  const out = [];
  for (const area of ['engine', 'platform', 'grid']) {
    for (const file of await walk(path.join(FRAMEWORK_SRC, area))) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts') || TEST_FILE.test(file)) continue;
      const rel = path.relative(FRAMEWORK_SRC, file).split(path.sep).join('/').replace(/\.ts$/, '');
      if (forDrafts(rel)) out.push(`${FRAMEWORK}/${rel}`);
    }
  }
  return out;
}

/** Bare imports in the game's content sources (relative, alias and virtual ones excluded). */
async function packageImports(root, sourceRoots) {
  const require = createRequire(import.meta.url);
  const { transform } = require('sucrase');
  const { init, parse } = await import('es-module-lexer');
  await init;
  const found = new Set();
  for (const sourceRoot of sourceRoots) {
    for (const file of await walk(path.resolve(root, sourceRoot))) {
      if (!SOURCE_FILE.test(file) || TEST_FILE.test(file)) continue;
      let code = await readFile(file, 'utf8');
      if (/\.(ts|tsx|mts)$/.test(file)) {
        code = transform(code, {
          transforms: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
          disableESTransforms: true,
          preserveDynamicImport: true,
        }).code;
      }
      let imports;
      try {
        [imports] = parse(code, file);
      } catch {
        continue;
      }
      for (const { n } of imports) {
        if (!n || /^(\.|\/|@\/|\0|virtual:|node:|https?:|data:)/.test(n)) continue;
        found.add(n);
      }
    }
  }
  return [...found];
}

/** The draft service worker as one classic script (no module service worker needed). */
async function bundleDraftWorker() {
  const { build } = await import('vite');
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    root: path.dirname(DRAFT_WORKER_ENTRY),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      emptyOutDir: false,
      copyPublicDir: false,
      lib: {
        entry: DRAFT_WORKER_ENTRY,
        formats: ['iife'],
        name: 'ConstructDraftWorker',
        fileName: () => DRAFT_WORKER_FILE,
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => output.output ?? [],
  );
  const chunk = outputs.find((file) => file.type === 'chunk');
  if (!chunk) throw new Error('constructDraftPlugin: the draft service worker bundle is empty');
  return chunk.code;
}

/**
 * Crowdy Studio's hosted game-editor preview (`platform/live/draftLoader.ts`):
 * - `virtual:construct-draft-host`, a lazy registry of what a draft module may
 *   import from the page: every public framework module, every package the
 *   game's content sources import (`sourceRoots`, default `src` and `model`),
 *   and `extraModules`;
 * - `construct-draft-sw.js`, the draft service worker, next to index.html in
 *   the build and on the dev server.
 *
 * @param {{ sourceRoots?: string[], extraModules?: string[] }} [options]
 * @returns {import('vite').Plugin}
 */
export function constructDraftPlugin(options = {}) {
  const resolvedId = `\0${DRAFT_HOST_MODULES}`;
  /** @type {import('vite').ResolvedConfig | undefined} */
  let config;
  /** @type {Promise<string> | null} */
  let worker = null;
  const workerCode = () => (worker ??= bundleDraftWorker());
  return {
    name: 'construct-draft',
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      return id === DRAFT_HOST_MODULES ? resolvedId : undefined;
    },
    async load(id) {
      if (id !== resolvedId || !config) return undefined;
      const specifiers = new Set([
        ...(await frameworkModules()),
        ...(await packageImports(config.root, options.sourceRoots ?? ['src', 'model'])),
        ...(options.extraModules ?? []),
      ]);
      const rows = [...specifiers]
        .sort()
        .map(
          (specifier) =>
            `  ${JSON.stringify(specifier)}: () => import(${JSON.stringify(specifier)}),`,
        );
      return `export default {\n${rows.join('\n')}\n};\n`;
    },
    async generateBundle() {
      if (config?.command !== 'build') return;
      this.emitFile({ type: 'asset', fileName: DRAFT_WORKER_FILE, source: await workerCode() });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (pathname !== `${server.config.base}${DRAFT_WORKER_FILE}`) return next();
        workerCode().then(
          (code) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(code);
          },
          (error) => next(error),
        );
      });
    },
  };
}
