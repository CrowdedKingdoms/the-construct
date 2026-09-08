import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ISOLATION_HEADERS,
  PERMISSIONS_POLICY,
  buildCsp,
  securityHeaders,
  tierZoneWildcards,
} from './security-headers.mjs';

test('isolation headers are present and take the isolating values', () => {
  const headers = securityHeaders({ apiOrigins: ['https://ck.prod.example.com'] });
  for (const name of ISOLATION_HEADERS) assert.ok(headers[name], `${name} missing`);
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['Cross-Origin-Embedder-Policy'], 'credentialless');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
});

test('csp admits the configured API origin, its wss twin, and one-label zone wildcard only', () => {
  const csp = buildCsp({ apiOrigins: ['https://ck.prod.example.com/graphql'] });
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src '));
  assert.ok(connect);
  const sources = connect.replace('connect-src ', '').split(' ');
  assert.deepEqual(sources, [
    "'self'",
    'https://ck.prod.example.com',
    'wss://ck.prod.example.com',
    'https://*.prod.example.com',
    'wss://*.prod.example.com',
  ]);
});

test('csp never relaxes inline script and keeps workers same-origin', () => {
  const csp = buildCsp({ apiOrigins: ['https://ck.dev.example.com'] });
  assert.ok(!csp.includes("'unsafe-inline'") || csp.includes("style-src 'self' 'unsafe-inline'"));
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('localhost and IP origins get no wildcard', () => {
  assert.deepEqual(tierZoneWildcards(['http://localhost:3000', 'http://127.0.0.1:3000']), []);
});

test('a dev-tier origin cannot widen to a prod zone', () => {
  const csp = buildCsp({ apiOrigins: ['https://ck.dev.example.com'] });
  assert.ok(!csp.includes('prod.example.com'));
});

test('extra connect sources are appended exactly and de-duplicated', () => {
  const csp = buildCsp({
    apiOrigins: ['https://ck.prod.example.com'],
    extraConnectSrc: ['https://beacon.example.net', 'https://beacon.example.net'],
  });
  assert.equal(csp.split('https://beacon.example.net').length - 1, 1);
});

test('unparseable origins are ignored rather than emitted', () => {
  const csp = buildCsp({ apiOrigins: ['not a url', undefined, null] });
  assert.match(csp, /connect-src 'self'(;|$)/);
});

test('permissions policy lets the page use the camera and nothing else, and no embed anything', () => {
  const headers = securityHeaders({ apiOrigins: ['https://ck.prod.example.com'] });
  assert.equal(headers['Permissions-Policy'], PERMISSIONS_POLICY);
  assert.match(PERMISSIONS_POLICY, /(^|, )camera=\(self\)(,|$)/);
  // The microphone stays denied until voice is wired; a fork that adds voice
  // changes this to microphone=(self) and this assertion with it.
  assert.match(PERMISSIONS_POLICY, /(^|, )microphone=\(\)(,|$)/);
  assert.ok(!PERMISSIONS_POLICY.includes('*'), 'no wildcard grant');
});
