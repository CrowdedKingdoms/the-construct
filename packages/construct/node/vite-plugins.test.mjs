import assert from 'node:assert/strict';
import test from 'node:test';

import { constructHeaderPlugins } from './vite-plugins.mjs';

test('the harness headers follow the game under a Vite base', () => {
  const [plugin] = constructHeaderPlugins({
    dshHeaders: { 'Content-Security-Policy': "frame-ancestors 'self'" },
  });
  for (const [base, url, harness] of [
    ['/the-construct/', '/the-construct/dsh/index.html', true],
    ['/', '/dsh/index.html', true],
    ['/the-construct/', '/the-construct/index.html', false],
  ]) {
    let middleware;
    plugin.configurePreviewServer({
      config: { base },
      middlewares: { use: (fn) => (middleware = fn) },
    });
    const set = {};
    const res = {
      setHeader(name, value) {
        set[name] = value;
        return res;
      },
    };
    middleware({ url }, res, () => {});
    assert.equal('Content-Security-Policy' in set, harness, `${base} ${url}`);
  }
});

test('the packed harness image reaches the worker as stored: typed, never re-encoded', () => {
  const [plugin] = constructHeaderPlugins({ dshHeaders: {} });
  let middleware;
  plugin.configurePreviewServer({
    config: { base: '/game/' },
    middlewares: { use: (fn) => (middleware = fn) },
  });
  const set = {};
  const res = {
    setHeader(name, value) {
      set[name.toLowerCase()] = value;
      return res;
    },
  };
  middleware({ url: '/game/dsh/preview/vfs-image.tar.gz' }, res, () => {});
  res.setHeader('Content-Type', '');
  res.setHeader('Content-Encoding', 'gzip');
  assert.equal(set['content-type'], 'application/gzip');
  assert.equal('content-encoding' in set, false);
});
