/**
 * Dev-server draft working copy for live coding.
 *
 * `LIVE_DRAFT_ROOT` is a checkout of the bound game. Writes land there, and
 * Vite serves that tree's scenes and catalog so a draft updates the page
 * before anyone commits it to GitHub. This middleware is the dev server only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_BYTES = 1_000_000;

export function isWritableGamePath(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!SAFE_SEGMENT.test(filePath) || filePath.includes('..') || filePath.endsWith('/')) return false;
  if (filePath === 'model/catalog.mjs') return true;
  if (filePath === 'exec/construct' || filePath.startsWith('exec/construct/')) return true;
  return filePath.startsWith('src/scenes/') && /\.(?:mjs|js|ts)$/.test(filePath);
}

/** Absolute path of a writable game file inside `root`, or null. */
export function draftFile(root, filePath) {
  if (!isWritableGamePath(filePath)) return null;
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
export function liveDraftPlugin(root) {
  const base = path.resolve(root);
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
            const filePath = url.searchParams.get('path') ?? '';
            const abs = draftFile(base, filePath);
            if (!abs) return send(res, 400, 'That path is not a scene, the catalog, or a world-hub file.');
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
              return send(res, 400, 'That path is not a scene, the catalog, or a world-hub file.');
            }
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, content);
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
