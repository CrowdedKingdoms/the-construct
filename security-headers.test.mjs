import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ISOLATION_HEADERS,
  PERMISSIONS_POLICY,
  buildCsp,
  buildDshCsp,
  dshSecurityHeaders,
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
  assert.match(csp, /frame-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('dsh csp relaxes script-src for the worker and permits same-origin frame ancestors', () => {
  const csp = buildDshCsp({ apiOrigins: ['https://ck.dev.example.com'] });
  assert.match(csp, /script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /frame-src 'self'/);
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src '));
  assert.ok(connect?.includes('blob:'));
  const headers = dshSecurityHeaders({ apiOrigins: ['https://ck.dev.example.com'] });
  assert.equal(headers['Cross-Origin-Embedder-Policy'], 'credentialless');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('a framed game names exactly its framer; the DSH pane names the framer beside self', () => {
  // The Crowdy Games shell (or a shell of your own) frames the game; frame-ancestors is
  // checked against EVERY ancestor, so the pane -- framed by the game, framed by the
  // shell -- must admit both, and the game page must admit only the shell.
  const framed = {
    apiOrigins: ['https://ck.dev.example.com'],
    frameAncestors: ['https://games.example.test/some/path'],
  };
  assert.match(buildCsp(framed), /frame-ancestors https:\/\/games\.example\.test(;|$)/);
  assert.doesNotMatch(buildCsp(framed), /frame-ancestors 'none'/);
  assert.match(buildDshCsp(framed), /frame-ancestors 'self' https:\/\/games\.example\.test(;|$)/);
  // Unframed (the default) is unchanged.
  assert.match(buildCsp({ apiOrigins: ['https://ck.dev.example.com'] }), /frame-ancestors 'none'/);
  assert.match(
    buildDshCsp({ apiOrigins: ['https://ck.dev.example.com'] }),
    /frame-ancestors 'self'(;|$)/,
  );
  // Garbage is not an ancestor.
  assert.match(buildCsp({ frameAncestors: ['not a url'] }), /frame-ancestors 'none'/);
  // CORP follows: a framed document must be embeddable under the shell's COEP.
  assert.equal(securityHeaders(framed)['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.equal(dshSecurityHeaders(framed)['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.equal(
    securityHeaders({ apiOrigins: ['https://ck.dev.example.com'] })['Cross-Origin-Resource-Policy'],
    'same-origin',
  );
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

test('permissions policy lets the page use the camera and microphone, and no embed anything', () => {
  const headers = securityHeaders({ apiOrigins: ['https://ck.prod.example.com'] });
  assert.equal(headers['Permissions-Policy'], PERMISSIONS_POLICY);
  assert.match(PERMISSIONS_POLICY, /(^|, )camera=\(self\)(,|$)/);
  assert.match(PERMISSIONS_POLICY, /(^|, )microphone=\(self\)(,|$)/);
  assert.ok(!PERMISSIONS_POLICY.includes('*'), 'no wildcard grant');
});
