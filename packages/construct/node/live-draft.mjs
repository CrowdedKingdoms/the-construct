/**
 * The dev-server backend of Crowdy Studio's game editor: on a local dev
 * server the game's own checkout is the draft. The page's
 * `DevServerDraftStore` (src/platform/live) talks to this middleware, and
 * Vite HMR previews each change through the content layer.
 *
 * - The draft lists the files git would commit (`git ls-files -co
 *   --exclude-standard`) with their git blob ids; a file is dirty when it
 *   differs from HEAD, and deleted when HEAD has it and the disk does not.
 * - Writes carry the editor's preconditions (`createIfAbsent`, `ifHash`) and
 *   fail with 409 DRAFT_STALE instead of overwriting a newer file.
 * - Edits made on disk (your editor, a checkout) reach the page as
 *   `construct:draft` events on Vite's websocket; `construct:preview` events
 *   say when a change is outside what the running game loads.
 * - After Studio commits the draft to GitHub, `sync` moves HEAD to that
 *   commit (`git fetch`, then `git reset --mixed` when HEAD is its
 *   ancestor), so the checkout is clean again and no file is touched.
 * - Requests must come from this dev server's own page: same-origin
 *   (`Sec-Fetch-Site`, else `Origin`), the per-server token the page carries
 *   (`X-Construct-Draft-Token`), and JSON bodies only.
 *
 * Opt-in: `liveDraftPlugin()` in the game's vite config; it does nothing
 * unless the server runs with `LIVE_DRAFT=1`.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_READ_PATHS = 100;
const TOKEN_META = 'construct-live-draft';
const TOKEN_HEADER = 'x-construct-draft-token';
const CONTENT_ENTRY = 'src/game/content.ts';
/** How long a write by this server counts as its own when the watcher reports it. */
const OWN_WRITE_MS = 5_000;

function deniedSegment(segment) {
  return (
    segment === '.git' ||
    segment === 'node_modules' ||
    segment === '.env' ||
    segment.startsWith('.env.')
  );
}

/**
 * A file of the bound repository the editor may list and write: the same
 * policy as CrowdyJS `isRepoPath` (root dotfiles, `.git`, `node_modules`,
 * dotenv files and workflows are out).
 */
export function isRepoPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    !SAFE_PATH.test(filePath) ||
    filePath.includes('..') ||
    filePath.endsWith('/')
  )
    return false;
  if (filePath.split('/').some((segment) => segment === '' || deniedSegment(segment))) return false;
  return !/^\.github\/workflows(\/|$)/i.test(filePath);
}

/** Git's blob id for these bytes. */
export function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function textOrNull(bytes) {
  if (bytes.byteLength > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

class DraftHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The checkout as a draft. Exported for tests; the plugin below is the way in.
 */
export class CheckoutDraft {
  /** @param {string} root */
  constructor(root) {
    this.root = path.resolve(root);
    this.revision = 0;
    /** @type {Map<string, { mtimeMs: number, size: number, hash: string, binary: boolean }>} */
    this.stats = new Map();
    /** @type {{ sha: string, blobs: Map<string, string> } | null} */
    this.head = null;
    /** Writes this server made (path -> hash, or null for a delete, and when), so the watcher does not announce them twice. */
    this.ownWrites = new Map();
  }

  async git(...args) {
    const { stdout } = await run('git', args, { cwd: this.root, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  abs(filePath) {
    if (!isRepoPath(filePath))
      throw new DraftHttpError(
        403,
        'DRAFT_PATH_REFUSED',
        `${filePath} is not a file in the repository.`,
      );
    const abs = path.resolve(this.root, filePath);
    if (!abs.startsWith(this.root + path.sep)) {
      throw new DraftHttpError(403, 'DRAFT_PATH_REFUSED', `${filePath} is outside the repository.`);
    }
    return abs;
  }

  async headTree() {
    const sha = (await this.git('rev-parse', 'HEAD')).trim();
    if (this.head?.sha === sha) return this.head;
    const blobs = new Map();
    for (const row of (await this.git('ls-tree', '-r', '-z', '--full-tree', 'HEAD')).split('\0')) {
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [, type, blob] = row.slice(0, tab).split(' ');
      if (type === 'blob') blobs.set(row.slice(tab + 1), blob);
    }
    this.head = { sha, blobs };
    return this.head;
  }

  /** Hash and kind of a file on disk, cached by mtime and size; null when it is gone. */
  async fileInfo(filePath) {
    let info;
    try {
      info = await stat(this.abs(filePath));
    } catch {
      this.stats.delete(filePath);
      return null;
    }
    if (!info.isFile()) return null;
    const cached = this.stats.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const bytes = await readFile(this.abs(filePath));
    const entry = {
      mtimeMs: info.mtimeMs,
      size: bytes.byteLength,
      hash: gitBlobSha(bytes),
      binary: textOrNull(bytes) === null,
    };
    this.stats.set(filePath, entry);
    return entry;
  }

  async tree() {
    const head = await this.headTree();
    const listed = (await this.git('ls-files', '-z', '-c', '-o', '--exclude-standard'))
      .split('\0')
      .filter((filePath) => filePath && isRepoPath(filePath));
    const entries = [];
    const present = new Set();
    for (const filePath of [...new Set(listed)].sort()) {
      const info = await this.fileInfo(filePath);
      if (!info) continue;
      present.add(filePath);
      entries.push({
        path: filePath,
        hash: info.hash,
        size: info.size,
        binary: info.binary,
        dirty: head.blobs.get(filePath) !== info.hash,
      });
    }
    const deleted = [...head.blobs.keys()]
      .filter((filePath) => isRepoPath(filePath) && !present.has(filePath))
      .sort();
    return { baseCommitSha: head.sha, revision: this.revision, entries, deleted, truncated: false };
  }

  async read(paths) {
    if (!Array.isArray(paths) || paths.length > MAX_READ_PATHS) {
      throw new DraftHttpError(
        400,
        'DRAFT_TOO_LARGE',
        `Read at most ${MAX_READ_PATHS} paths at a time.`,
      );
    }
    const files = [];
    const missing = [];
    const binary = [];
    for (const filePath of paths) {
      if (!isRepoPath(filePath)) {
        missing.push(filePath);
        continue;
      }
      let bytes;
      try {
        bytes = await readFile(this.abs(filePath));
      } catch {
        missing.push(filePath);
        continue;
      }
      const text = textOrNull(bytes);
      if (text === null) binary.push(filePath);
      else files.push({ path: filePath, hash: gitBlobSha(bytes), content: text });
    }
    return { files, missing, binary };
  }

  async checkPrecondition(filePath, precondition) {
    if (!precondition) return;
    const current = await this.fileInfo(filePath);
    if (precondition.kind === 'createIfAbsent' && current) {
      throw new DraftHttpError(
        409,
        'DRAFT_STALE',
        `${filePath} already exists; read it before replacing it.`,
      );
    }
    if (precondition.kind === 'ifHash' && current?.hash !== precondition.hash) {
      throw new DraftHttpError(
        409,
        'DRAFT_STALE',
        `${filePath} changed since it was read; read it again.`,
      );
    }
  }

  async write(filePath, content, precondition) {
    if (typeof content !== 'string')
      throw new DraftHttpError(400, 'DRAFT_PATH_REFUSED', 'A write needs text content.');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new DraftHttpError(
        413,
        'DRAFT_TOO_LARGE',
        `${filePath} is larger than the editor writes (512 KiB).`,
      );
    }
    const abs = this.abs(filePath);
    await this.checkPrecondition(filePath, precondition);
    const previous = await this.fileInfo(filePath);
    await mkdir(path.dirname(abs), { recursive: true });
    const hash = gitBlobSha(bytes);
    this.markOwn(filePath, hash);
    await writeFile(abs, bytes);
    this.stats.delete(filePath);
    this.revision += 1;
    const head = await this.headTree();
    return {
      path: filePath,
      hash,
      previousHash: previous?.hash ?? null,
      revision: this.revision,
      dirty: head.blobs.get(filePath) !== hash,
    };
  }

  async remove(filePath, precondition) {
    const abs = this.abs(filePath);
    const previous = await this.fileInfo(filePath);
    if (!previous)
      throw new DraftHttpError(404, 'DRAFT_NOT_FOUND', `${filePath} is not in the draft.`);
    await this.checkPrecondition(filePath, precondition);
    this.markOwn(filePath, null);
    await rm(abs);
    this.stats.delete(filePath);
    this.revision += 1;
    const head = await this.headTree();
    return {
      path: filePath,
      previousHash: previous.hash,
      revision: this.revision,
      inHead: head.blobs.has(filePath),
    };
  }

  /** Put `paths` (default: every dirty or deleted file) back as HEAD has them. */
  async discard(paths) {
    const head = await this.headTree();
    const tree = await this.tree();
    const changed = [
      ...tree.entries.filter((entry) => entry.dirty).map((entry) => entry.path),
      ...tree.deleted,
    ];
    const wanted = Array.isArray(paths)
      ? changed.filter((filePath) => paths.includes(filePath))
      : changed;
    for (const filePath of wanted) {
      const abs = this.abs(filePath);
      if (head.blobs.has(filePath)) {
        const { stdout } = await run('git', ['cat-file', 'blob', head.blobs.get(filePath)], {
          cwd: this.root,
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
        });
        this.markOwn(filePath, head.blobs.get(filePath));
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, stdout);
      } else {
        this.markOwn(filePath, null);
        await rm(abs, { force: true });
      }
      this.stats.delete(filePath);
    }
    this.revision += 1;
    return { revision: this.revision, discarded: wanted };
  }

  markOwn(filePath, hash) {
    const now = Date.now();
    for (const [key, write] of this.ownWrites)
      if (now - write.at > OWN_WRITE_MS) this.ownWrites.delete(key);
    this.ownWrites.set(filePath, { hash, at: now });
  }

  /** Whether this server wrote `filePath` moments ago (with `hash`, when given). */
  isOwnWrite(filePath, hash) {
    const write = this.ownWrites.get(filePath);
    if (!write || Date.now() - write.at > OWN_WRITE_MS) return false;
    return hash === undefined || write.hash === hash;
  }

  /** Move HEAD to the commit Studio just made from this draft, leaving every file as it is. */
  async sync(commitSha) {
    if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) {
      throw new DraftHttpError(
        400,
        'DRAFT_PATH_REFUSED',
        'sync needs the 40-character commit sha.',
      );
    }
    try {
      await this.git('cat-file', '-e', `${commitSha}^{commit}`);
    } catch {
      try {
        await this.git('fetch', '--quiet', 'origin');
      } catch (error) {
        throw new DraftHttpError(
          409,
          'DRAFT_UNAVAILABLE',
          `Committed as ${commitSha.slice(0, 7)}, but this checkout could not fetch it (${error.message.trim()}). Pull to update it.`,
        );
      }
    }
    try {
      await this.git('merge-base', '--is-ancestor', 'HEAD', commitSha);
    } catch {
      throw new DraftHttpError(
        409,
        'DRAFT_CONFLICT',
        `Committed as ${commitSha.slice(0, 7)}, but HEAD is not behind it; pull to update this checkout.`,
      );
    }
    await this.git('reset', '--mixed', '--quiet', commitSha);
    this.head = null;
    this.revision += 1;
    return { baseCommitSha: commitSha, revision: this.revision };
  }

  /** A watcher event for `file`: the change to announce, or null when it is ours or not a repository file. */
  async diskChange(file) {
    const rel = path.relative(this.root, file).split(path.sep).join('/');
    if (rel.startsWith('..') || !isRepoPath(rel)) return null;
    this.stats.delete(rel);
    const info = await this.fileInfo(rel);
    const hash = info?.hash ?? null;
    if (this.isOwnWrite(rel, hash)) return null;
    this.revision += 1;
    return { revision: this.revision, changes: [{ path: rel, hash }] };
  }
}

function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin';
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.toLowerCase().startsWith('application/json')) {
      reject(new DraftHttpError(415, 'DRAFT_PATH_REFUSED', 'The draft API takes JSON only.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DraftHttpError(413, 'DRAFT_TOO_LARGE', 'The request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new DraftHttpError(400, 'DRAFT_PATH_REFUSED', 'The body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** Whether a change to `mod` stops at an accept boundary (the content entry, or a self-accepting module). */
function reachesBoundary(mod, contentEntry, seen = new Set()) {
  if (mod.file === contentEntry || mod.isSelfAccepting) return true;
  if (seen.has(mod)) return true;
  seen.add(mod);
  if (mod.importers.size === 0) return false;
  for (const importer of mod.importers) {
    if (importer.acceptedHmrDeps?.has(mod)) continue;
    if (!reachesBoundary(importer, contentEntry, seen)) return false;
  }
  return true;
}

/**
 * @param {{ root?: string, enabled?: boolean }} [options] `root` defaults to the Vite root;
 *   `enabled` to `LIVE_DRAFT=1` in the environment.
 * @returns {import('vite').Plugin}
 */
export function liveDraftPlugin(options = {}) {
  const enabled = options.enabled ?? process.env.LIVE_DRAFT === '1';
  const token = randomBytes(24).toString('base64url');
  /** @type {CheckoutDraft | null} */
  let draft = null;
  let contentEntry = '';
  return {
    name: 'construct-live-draft',
    apply: 'serve',
    configResolved(config) {
      if (!enabled) return;
      draft = new CheckoutDraft(options.root ?? config.root);
      contentEntry = path.join(draft.root, CONTENT_ENTRY);
    },
    transformIndexHtml() {
      if (!draft) return undefined;
      return [{ tag: 'meta', attrs: { name: TOKEN_META, content: token }, injectTo: 'head' }];
    },
    configureServer(server) {
      if (!draft) return;
      const checkout = draft;
      const prefix = `${server.config.base}__live-draft/`;
      server.config.logger.info(`construct live draft: the game editor edits ${checkout.root}`);
      const announce = async (file) => {
        const change = await checkout.diskChange(file).catch(() => null);
        if (change)
          server.ws.send({
            type: 'custom',
            event: 'construct:draft',
            data: { ...change, source: 'player' },
          });
      };
      server.watcher.on('change', announce);
      server.watcher.on('add', announce);
      server.watcher.on('unlink', announce);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://dev.invalid');
        if (!url.pathname.startsWith(prefix)) return next();
        try {
          if (!sameOrigin(req) || req.headers[TOKEN_HEADER] !== token) {
            throw new DraftHttpError(
              403,
              'DRAFT_PATH_REFUSED',
              'The draft API answers this dev server’s own page only.',
            );
          }
          const action = url.pathname.slice(prefix.length);
          if (req.method === 'GET' && action === 'tree')
            return send(res, 200, await checkout.tree());
          if (req.method !== 'POST')
            throw new DraftHttpError(405, 'DRAFT_PATH_REFUSED', 'Use POST.');
          const body = await readJson(req);
          switch (action) {
            case 'read':
              return send(res, 200, await checkout.read(body.paths));
            case 'write': {
              const result = await checkout.write(
                String(body.path ?? ''),
                body.content,
                body.precondition,
              );
              server.ws.send({
                type: 'custom',
                event: 'construct:draft',
                data: {
                  revision: result.revision,
                  changes: [{ path: result.path, hash: result.hash }],
                  source: body.source === 'agent' ? 'agent' : 'player',
                  writer: body.writer,
                },
              });
              return send(res, 200, result);
            }
            case 'delete': {
              const result = await checkout.remove(String(body.path ?? ''), body.precondition);
              server.ws.send({
                type: 'custom',
                event: 'construct:draft',
                data: {
                  revision: result.revision,
                  changes: [{ path: result.path, hash: null }],
                  source: body.source === 'agent' ? 'agent' : 'player',
                  writer: body.writer,
                },
              });
              return send(res, 200, result);
            }
            case 'discard': {
              const result = await checkout.discard(body.paths);
              server.ws.send({
                type: 'custom',
                event: 'construct:draft',
                data: {
                  revision: result.revision,
                  changes: [],
                  source: 'reload',
                  writer: body.writer,
                },
              });
              return send(res, 200, result);
            }
            case 'sync': {
              const result = await checkout.sync(body.commitSha);
              server.ws.send({
                type: 'custom',
                event: 'construct:draft',
                data: { ...result, changes: [], source: 'commit', writer: body.writer },
              });
              return send(res, 200, result);
            }
            default:
              throw new DraftHttpError(404, 'DRAFT_NOT_FOUND', `No draft action ${action}.`);
          }
        } catch (error) {
          if (error instanceof DraftHttpError)
            return send(res, error.status, { code: error.code, message: error.message });
          return send(res, 500, {
            code: 'DRAFT_UNAVAILABLE',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
    handleHotUpdate({ file, modules, server }) {
      if (!draft) return undefined;
      const rel = path.relative(draft.root, file).split(path.sep).join('/');
      if (rel.startsWith('..') || !isRepoPath(rel)) return undefined;
      const ours = draft.isOwnWrite(rel);
      if (modules.length === 0) {
        server.ws.send({
          type: 'custom',
          event: 'construct:preview',
          data: { path: rel, kind: 'not-loaded', revision: draft.revision },
        });
        return undefined;
      }
      if (modules.every((mod) => reachesBoundary(mod, contentEntry))) return undefined;
      server.ws.send({
        type: 'custom',
        event: 'construct:preview',
        data: { path: rel, kind: 'needs-reload', revision: draft.revision },
      });
      // A full reload would end the Studio agent's turn: hold it for the editor's own writes.
      return ours ? [] : undefined;
    },
  };
}
