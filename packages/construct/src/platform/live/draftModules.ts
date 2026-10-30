/**
 * How the draft service worker turns draft files into modules the page can
 * import. Pure functions, shared by the worker and the tests.
 *
 * URLs, all under the game's base (`BASE`):
 * - `BASE__draft/g<generation>/<repo path>`: a draft file as an ES module.
 *   TypeScript is stripped (sucrase keeps line numbers, so stack traces point
 *   at the draft file); every import is rewritten to another draft URL of the
 *   same generation, a host shim, or a module that throws a clear error.
 * - `BASE__draft/host/<specifier>.js`: a shim re-exporting the page's own
 *   module for a bare or framework import, so a draft scene shares `three`,
 *   the framework and its singletons with the running game.
 * - `BASE__draft/missing/<specifier>`: an import the draft cannot satisfy.
 *
 * A new generation re-imports the whole draft graph under new URLs; the
 * browser's module map caches the old one until the page reloads.
 */
// The pure-JS build: no WebAssembly (a `script-src 'self'` page cannot compile it) and no init.
import { parse } from 'es-module-lexer/js';
import { transform } from 'sucrase';

import type { PreviewError } from './content';

export const DRAFT_SEGMENT = '__draft/';
/** The service worker's file name, next to the game's index.html. */
export const DRAFT_WORKER_FILE = 'construct-draft-sw.js';
/** The content entry every generation imports. */
export const CONTENT_ENTRY = 'src/game/content.ts';

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'];
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);

export type DraftRequest =
  | { kind: 'module'; generation: number; path: string }
  | { kind: 'host'; specifier: string }
  | { kind: 'missing'; specifier: string; importer: string };

/** What a pathname under the draft segment asks for, or null when it is not a draft URL. */
export function parseDraftUrl(pathname: string, base: string): DraftRequest | null {
  const prefix = `${base}${DRAFT_SEGMENT}`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const generation = /^g(\d+)\/(.+)$/.exec(rest);
  if (generation) {
    const path = decodeURIComponent(generation[2] ?? '');
    if (!isDraftPath(path)) return null;
    return { kind: 'module', generation: Number(generation[1]), path };
  }
  const host = /^host\/(.+)\.js$/.exec(rest);
  if (host) return { kind: 'host', specifier: decodeURIComponent(host[1] ?? '') };
  const missing = /^missing\/([^/]+)\/(.+)$/.exec(rest);
  if (missing) {
    return {
      kind: 'missing',
      importer: decodeURIComponent(missing[1] ?? ''),
      specifier: decodeURIComponent(missing[2] ?? ''),
    };
  }
  return null;
}

export function draftModuleUrl(base: string, generation: number, path: string): string {
  return `${base}${DRAFT_SEGMENT}g${generation}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function hostShimUrl(base: string, specifier: string): string {
  return `${base}${DRAFT_SEGMENT}host/${encodeURIComponent(specifier)}.js`;
}

function missingUrl(base: string, importer: string, specifier: string): string {
  return `${base}${DRAFT_SEGMENT}missing/${encodeURIComponent(importer)}/${encodeURIComponent(specifier)}`;
}

/** A relative repository path with no traversal: what a draft URL may name. */
function isDraftPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join('/');
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

export type Resolution =
  { kind: 'draft'; path: string } | { kind: 'host'; specifier: string } | { kind: 'missing' };

/**
 * Resolve an import written in a draft file: `./`, `../`, `/` and the
 * template's `@/` (src/) alias name draft files; anything else is the host's.
 * Extensions resolve as Vite does for this template.
 */
export function resolveSpecifier(
  specifier: string,
  importer: string,
  paths: ReadonlySet<string>,
): Resolution {
  let target: string | null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    target = normalize(`${importer.slice(0, importer.lastIndexOf('/') + 1)}${specifier}`);
  } else if (specifier.startsWith('@/')) {
    target = normalize(`src/${specifier.slice(2)}`);
  } else if (specifier.startsWith('/')) {
    target = normalize(specifier.slice(1));
  } else {
    return { kind: 'host', specifier };
  }
  if (!target) return { kind: 'missing' };
  const candidates = [
    target,
    ...RESOLVE_EXTENSIONS.map((extension) => `${target}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${target}/index${extension}`),
  ];
  for (const candidate of candidates) {
    if (paths.has(candidate)) return { kind: 'draft', path: candidate };
  }
  return { kind: 'missing' };
}

export class DraftTransformError extends Error {
  constructor(
    message: string,
    readonly error: PreviewError,
  ) {
    super(message);
    this.name = 'DraftTransformError';
  }
}

/**
 * A draft file as a module of generation `generation`. Throws a
 * `DraftTransformError` carrying the file and line for a syntax error.
 */
export async function transformDraftModule(options: {
  source: string;
  path: string;
  generation: number;
  base: string;
  paths: ReadonlySet<string>;
}): Promise<string> {
  const { source, path, generation, base, paths } = options;
  const extension = extensionOf(path);
  if (extension === '.json') {
    try {
      return `export default ${JSON.stringify(JSON.parse(source))};\n`;
    } catch (error) {
      throw new DraftTransformError(`${path}: ${(error as Error).message}`, {
        path,
        message: (error as Error).message,
      });
    }
  }
  if (!SCRIPT_EXTENSIONS.has(extension)) {
    const message = `${path} cannot be previewed (${extension || 'no extension'}): only TypeScript, JavaScript and JSON load from the draft.`;
    throw new DraftTransformError(message, { path, message });
  }
  let code = source;
  if (extension === '.ts' || extension === '.tsx' || extension === '.mts') {
    try {
      code = transform(source, {
        transforms: extension === '.tsx' ? ['typescript', 'jsx'] : ['typescript'],
        disableESTransforms: true,
        preserveDynamicImport: true,
        production: true,
        filePath: path,
      }).code;
    } catch (error) {
      const loc = (error as { loc?: { line: number; column: number } }).loc;
      const message = (error as Error).message;
      throw new DraftTransformError(
        `${path}${loc ? `:${loc.line}:${loc.column + 1}` : ''}: ${message}`,
        {
          path,
          ...(loc ? { line: loc.line, column: loc.column + 1 } : {}),
          message,
        },
      );
    }
  }
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(code, path);
  } catch (error) {
    const idx = (error as { idx?: number }).idx;
    const line = idx === undefined ? undefined : code.slice(0, idx).split('\n').length;
    const message = (error as Error).message;
    throw new DraftTransformError(`${path}${line ? `:${line}` : ''}: ${message}`, {
      path,
      ...(line ? { line } : {}),
      message,
    });
  }
  const rewriteSpecifier = (specifier: string): string => {
    const resolution = resolveSpecifier(specifier, path, paths);
    if (resolution.kind === 'draft') return draftModuleUrl(base, generation, resolution.path);
    if (resolution.kind === 'host') return hostShimUrl(base, resolution.specifier);
    return missingUrl(base, path, specifier);
  };
  // Back to front, so earlier offsets stay valid.
  for (const entry of [...imports].sort((a, b) => b.s - a.s)) {
    if (entry.d === -2) {
      const after = code.slice(entry.e);
      if (after.startsWith('.env')) {
        code = `${code.slice(0, entry.s)}globalThis.__constructDraftEnv${code.slice(entry.e + 4)}`;
      } else if (after.startsWith('.hot')) {
        code = `${code.slice(0, entry.s)}(void 0)${code.slice(entry.e + 4)}`;
      }
      continue;
    }
    if (entry.n === undefined) continue;
    const written = code.slice(entry.s, entry.e);
    const quote = written[0] === '"' || written[0] === "'" || written[0] === '`' ? written[0] : '';
    const url = rewriteSpecifier(entry.n);
    code = `${code.slice(0, entry.s)}${quote ? JSON.stringify(url) : url}${code.slice(entry.e)}`;
  }
  return code;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval'.split(
    ' ',
  ),
);

/** A shim re-exporting the page's module for `specifier` with these export names. */
export function hostShimSource(specifier: string, names: readonly string[]): string {
  const lines = [`const m = await globalThis.__constructDraftHost(${JSON.stringify(specifier)});`];
  names.forEach((name, index) => {
    const local = `__e${index}`;
    lines.push(`const ${local} = m[${JSON.stringify(name)}];`);
    const exported =
      name === 'default' || (IDENTIFIER.test(name) && !RESERVED.has(name))
        ? name
        : JSON.stringify(name);
    lines.push(`export { ${local} as ${exported} };`);
  });
  return `${lines.join('\n')}\n`;
}

/** A module that fails to load with `error`, so the import names the file and line. */
export function errorModuleSource(error: PreviewError): string {
  const where = error.path
    ? `${error.path}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ''}` : ''}: `
    : '';
  return `const error = new Error(${JSON.stringify(`${where}${error.message}`)});\nerror.preview = ${JSON.stringify(error)};\nthrow error;\n`;
}
