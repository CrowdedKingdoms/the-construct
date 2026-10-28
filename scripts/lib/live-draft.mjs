/**
 * Dev-server draft working copy for live coding.
 *
 * `LIVE_DRAFT_ROOT` is a checkout of the bound game. Writes land there, and
 * Vite serves that tree's scenes and catalog so a draft updates the page
 * before anyone commits it to GitHub. This middleware is the dev server only.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_BYTES = 1_000_000;

function deniedSegment(segment) {
  return segment === '.git' || segment === 'node_modules' || segment === '.env' || segment.startsWith('.env.');
}

/** A relative path in the bound game repository. */
export function isRepoPath(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!SAFE_SEGMENT.test(filePath) || filePath.includes('..') || filePath.endsWith('/')) return false;
  return !filePath.split('/').some(deniedSegment);
}

/** A repository directory, including the root. */
export function isRepoDir(filePath) {
  if (filePath === '') return true;
  return isRepoPath(filePath);
}

/** Kept for callers that still import the old name. The repository policy replaced the scene allowlist. */
export function isWritableGamePath(filePath) {
  return isRepoPath(filePath);
}

/** Absolute path of a writable game file inside `root`, or null. */
export function draftFile(root, filePath) {
  if (!isRepoPath(filePath)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, filePath);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error('Draft body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {string} root checkout the draft files are written into
 */
function draftDir(root, dirPath) {
  if (!isRepoDir(dirPath)) return null;
  const base = path.resolve(root);
  const abs = dirPath === '' ? base : path.resolve(base, dirPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

export function liveDraftPlugin(root) {
  const base = path.resolve(root);
  const dirty = new Set();
  return {
    name: 'local-live-draft',
    resolveId(source) {
      const normalized = String(source).replaceAll('\\', '/');
      if (normalized === 'model/catalog.mjs' || normalized.endsWith('/model/catalog.mjs')) {
        return path.join(base, 'model/catalog.mjs');
      }
      return null;
    },
    configureServer(server) {
      console.info(`local live-code mock: draft working copy ${base}`);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__live-draft') return next();
        try {
          if (req.method === 'GET') {
            if (url.searchParams.get('dirty') === '1') {
              return send(res, 200, JSON.stringify({ paths: [...dirty] }), 'application/json');
            }
            if (url.searchParams.has('dir')) {
              const dirPath = url.searchParams.get('dir') ?? '';
              const abs = draftDir(base, dirPath);
              if (!abs) return send(res, 400, 'That path is not a directory in the bound repository.');
              const entries = readdirSync(abs, { withFileTypes: true })
                .filter((entry) => !deniedSegment(entry.name) && SAFE_SEGMENT.test(entry.name))
                .map((entry) => ({
                  name: entry.name,
                  type: entry.isDirectory() ? 'directory' : 'file',
                }));
              return send(res, 200, JSON.stringify({ entries }), 'application/json');
            }
            const filePath = url.searchParams.get('path') ?? '';
            const abs = draftFile(base, filePath);
            if (!abs) return send(res, 400, 'That path is not a file in the bound repository.');
            const content = readFileSync(abs, 'utf8');
            return send(res, 200, JSON.stringify({ path: filePath, content }), 'application/json');
          }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            const body = JSON.parse(raw);
            const filePath = typeof body.path === 'string' ? body.path : '';
            const content = typeof body.content === 'string' ? body.content : null;
            const abs = draftFile(base, filePath);
            if (!abs || content === null) {
              return send(res, 400, 'That path is not a file in the bound repository.');
            }
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, content);
            dirty.add(filePath);
            console.info(`local live-code mock: drafted ${filePath}`);
            return send(res, 200, JSON.stringify({ path: filePath }), 'application/json');
          }
          return send(res, 405, 'Use GET or POST');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Draft failed';
          return send(res, 400, message);
        }
      });
    },
  };
}
