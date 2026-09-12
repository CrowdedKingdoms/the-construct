import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constructDevServerOptions,
  envFlag,
  stripIsolationHeaders,
} from './dev-server-options.mjs';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Content-Security-Policy': "default-src 'self'",
};

describe('constructDevServerOptions', () => {
  it('defaults to isolation headers and no proxy', () => {
    const server = constructDevServerOptions({ headers });
    assert.equal(server.allowedHosts, undefined);
    assert.equal(server.proxy, undefined);
    assert.deepEqual(server.headers, headers);
  });

  it('opts in to proxy, allowedHosts, and relaxed isolation', () => {
    const server = constructDevServerOptions({
      headers,
      proxy: true,
      allowAllHosts: true,
      relaxIsolation: true,
      proxyTarget: 'http://127.0.0.1:3000',
    });
    assert.equal(server.allowedHosts, true);
    assert.equal(server.proxy['/graphql'].target, 'http://127.0.0.1:3000');
    assert.equal(server.proxy['/realtime'].ws, true);
    assert.equal(server.headers['Cross-Origin-Opener-Policy'], undefined);
    assert.equal(server.headers['Content-Security-Policy'], "default-src 'self'");
  });
});

describe('envFlag', () => {
  it('is off unless explicitly enabled', () => {
    assert.equal(envFlag({}, 'VITE_DEV_PROXY'), false);
    assert.equal(envFlag({ VITE_DEV_PROXY: '0' }, 'VITE_DEV_PROXY'), false);
    assert.equal(envFlag({ VITE_DEV_PROXY: '1' }, 'VITE_DEV_PROXY'), true);
  });
});

describe('stripIsolationHeaders', () => {
  it('drops only COOP/COEP', () => {
    assert.deepEqual(stripIsolationHeaders(headers), {
      'Content-Security-Policy': "default-src 'self'",
    });
  });
});
