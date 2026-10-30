import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { CheckoutDraft, gitBlobSha, isRepoPath, liveDraftPlugin } from './live-draft.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** A bare origin and a clone of it with one commit. */
function checkout() {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-draft-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '--quiet', origin, work);
  mkdirSync(path.join(work, 'src/game'), { recursive: true });
  writeFileSync(path.join(work, 'src/game/content.ts'), 'export default 1;\n');
  writeFileSync(path.join(work, 'README.md'), '# Game\n');
  writeFileSync(path.join(work, '.gitignore'), 'dist/\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'first');
  git(work, 'push', '--quiet', 'origin', 'HEAD:main');
  return { dir, origin, work, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the editor sees repository files only, by the same policy as CrowdyJS', () => {
  assert.equal(isRepoPath('src/scenes/race/RaceScene.ts'), true);
  assert.equal(isRepoPath('src/.eslintrc.json'), true);
  for (const refused of [
    '.github/dependabot.yml',
    '.gitignore',
    '.github/workflows/ci.yml',
    '.git/config',
    'node_modules/x/index.js',
    'src/.env',
    '.env.local',
    '../x',
    'src/../x',
    '/etc/passwd',
    'a//b',
  ]) {
    assert.equal(isRepoPath(refused), false, refused);
  }
});

test('lists what git would commit, dirty against HEAD, with blob ids', async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  const draft = new CheckoutDraft(repo.work);
  mkdirSync(path.join(repo.work, 'dist'));
  writeFileSync(path.join(repo.work, 'dist/bundle.js'), 'ignored');
  writeFileSync(path.join(repo.work, 'src/new.ts'), 'export {};\n');
  rmSync(path.join(repo.work, 'README.md'));
  const tree = await draft.tree();
  assert.equal(tree.baseCommitSha, git(repo.work, 'rev-parse', 'HEAD'));
  const paths = tree.entries.map((entry) => entry.path);
  assert.deepEqual(paths, ['src/game/content.ts', 'src/new.ts']);
  assert.deepEqual(tree.deleted, ['README.md']);
  const content = tree.entries.find((entry) => entry.path === 'src/game/content.ts');
  assert.equal(content.hash, git(repo.work, 'hash-object', 'src/game/content.ts'));
  assert.equal(content.dirty, false);
  assert.equal(tree.entries.find((entry) => entry.path === 'src/new.ts').dirty, true);
});

test('writes keep their preconditions, and the dirty set shrinks again', async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  const draft = new CheckoutDraft(repo.work);
  const original = readFileSync(path.join(repo.work, 'src/game/content.ts'));
  await assert.rejects(draft.write('src/game/content.ts', 'x', { kind: 'createIfAbsent' }), {
    code: 'DRAFT_STALE',
  });
  await assert.rejects(
    draft.write('src/game/content.ts', 'x', { kind: 'ifHash', hash: 'f'.repeat(40) }),
    { code: 'DRAFT_STALE' },
  );
  const written = await draft.write('src/game/content.ts', 'export default 2;\n', {
    kind: 'ifHash',
    hash: gitBlobSha(original),
  });
  assert.equal(written.previousHash, gitBlobSha(original));
  assert.equal(written.revision, 1);
  assert.equal(
    (await draft.tree()).entries.find((entry) => entry.path === 'src/game/content.ts').dirty,
    true,
  );
  const restored = await draft.write('src/game/content.ts', original.toString('utf8'));
  assert.equal(restored.dirty, false);
  assert.equal(
    (await draft.tree()).entries.find((entry) => entry.path === 'src/game/content.ts').dirty,
    false,
  );
  await assert.rejects(draft.write('.github/workflows/ci.yml', 'on: push'), {
    code: 'DRAFT_PATH_REFUSED',
  });
});

test('discard puts files back as HEAD has them and drops new ones', async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  const draft = new CheckoutDraft(repo.work);
  await draft.write('src/game/content.ts', 'changed');
  await draft.write('src/new.ts', 'new');
  const removed = await draft.remove('README.md');
  assert.equal(removed.inHead, true);
  const result = await draft.discard();
  assert.deepEqual(result.discarded.sort(), ['README.md', 'src/game/content.ts', 'src/new.ts']);
  const tree = await draft.tree();
  assert.equal(
    tree.entries.some((entry) => entry.dirty),
    false,
  );
  assert.deepEqual(tree.deleted, []);
  assert.equal(readFileSync(path.join(repo.work, 'README.md'), 'utf8'), '# Game\n');
});

test('reads in batches, and says which files are missing or binary', async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  writeFileSync(path.join(repo.work, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const draft = new CheckoutDraft(repo.work);
  const result = await draft.read(['README.md', 'logo.png', 'nope.ts', '../outside']);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['README.md'],
  );
  assert.deepEqual(result.binary, ['logo.png']);
  assert.deepEqual(result.missing, ['nope.ts', '../outside']);
});

test('after a commit made elsewhere, sync fast-forwards HEAD and leaves the files alone', async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  const draft = new CheckoutDraft(repo.work);
  await draft.write('src/game/content.ts', 'export default 3;\n');
  await draft.write('src/other.ts', 'export const later = true;\n');
  // Studio commits content.ts alone, through GitHub: model that with another clone.
  const elsewhere = path.join(repo.dir, 'elsewhere');
  git(repo.dir, 'clone', '--quiet', repo.origin, elsewhere);
  writeFileSync(path.join(elsewhere, 'src/game/content.ts'), 'export default 3;\n');
  git(elsewhere, 'commit', '--quiet', '-am', 'from studio');
  git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main');
  const commitSha = git(elsewhere, 'rev-parse', 'HEAD');
  const synced = await draft.sync(commitSha);
  assert.equal(synced.baseCommitSha, commitSha);
  assert.equal(git(repo.work, 'rev-parse', 'HEAD'), commitSha);
  const tree = await draft.tree();
  assert.equal(tree.entries.find((entry) => entry.path === 'src/game/content.ts').dirty, false);
  assert.equal(tree.entries.find((entry) => entry.path === 'src/other.ts').dirty, true);
  assert.equal(
    readFileSync(path.join(repo.work, 'src/other.ts'), 'utf8'),
    'export const later = true;\n',
  );
});

/** The plugin's middleware with a fake Vite server around it. */
function middlewareFor(root) {
  const plugin = liveDraftPlugin({ root, enabled: true });
  plugin.configResolved({ root });
  const [meta] = plugin.transformIndexHtml();
  const sent = [];
  let middleware;
  plugin.configureServer({
    config: { base: '/', logger: { info() {} } },
    watcher: { on() {} },
    ws: { send: (message) => sent.push(message) },
    middlewares: { use: (fn) => (middleware = fn) },
  });
  const call = (method, url, { headers = {}, body, remote = '127.0.0.1' } = {}) =>
    new Promise((resolve) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, {
        method,
        url,
        headers: { host: 'localhost:5175', ...headers },
        socket: { remoteAddress: remote },
      });
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(payload) {
          resolve({ status: this.statusCode, body: JSON.parse(payload) });
        },
      };
      void middleware(req, res, () => resolve({ status: 'next' }));
    });
  return { token: meta.attrs.content, call, sent };
}

test('the middleware answers only its own page, with the token, in JSON', async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  const { token, call, sent } = middlewareFor(repo.work);
  const own = { 'sec-fetch-site': 'same-origin', 'x-construct-draft-token': token };
  const json = { ...own, 'content-type': 'application/json' };
  const write = { path: 'README.md', content: 'pwned' };

  assert.equal(
    (
      await call('POST', '/__live-draft/write', {
        headers: {
          'sec-fetch-site': 'cross-site',
          'x-construct-draft-token': token,
          'content-type': 'application/json',
        },
        body: write,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('POST', '/__live-draft/write', {
        headers: {
          origin: 'http://evil.example',
          'x-construct-draft-token': token,
          'content-type': 'application/json',
        },
        body: write,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('POST', '/__live-draft/write', {
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: write,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('POST', '/__live-draft/write', {
        headers: { ...own, 'content-type': 'text/plain' },
        body: write,
      })
    ).status,
    415,
  );
  assert.equal(readFileSync(path.join(repo.work, 'README.md'), 'utf8'), '# Game\n');

  const tree = await call('GET', '/__live-draft/tree', { headers: own });
  assert.equal(tree.status, 200);
  const written = await call('POST', '/__live-draft/write', {
    headers: json,
    body: { ...write, source: 'agent', writer: 'tab-1' },
  });
  assert.equal(written.status, 200);
  assert.equal(sent.at(-1).data.source, 'agent');
  assert.equal(sent.at(-1).data.writer, 'tab-1');
  assert.equal((await call('GET', '/elsewhere')).status, 'next');
});
