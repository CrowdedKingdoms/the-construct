import { describe, expect, it, vi } from 'vitest';

// The SDK root barrel drags Monaco into a unit test; config only needs the
// two generated constants.
vi.mock('@crowdedkingdoms/crowdyjs', () => ({
  CROWDY_DEFAULT_HTTP_ORIGIN: 'https://ck.test.example',
  CROWDY_DEFAULT_TIER: 'test',
}));

const { resolveAppId, resolveAuthorizeUrl, resolveStudioOrigin, API_HTTP_URL, API_WS_URL } =
  await import('@/platform/config');

describe('resolveAppId', () => {
  it('prefers the URL, then storage, then the build', () => {
    expect(resolveAppId({ search: '?app=123', stored: '456', env: '789' })).toEqual({
      appId: '123',
      source: 'query',
    });
    expect(resolveAppId({ search: '', stored: '456', env: '789' })).toEqual({
      appId: '456',
      source: 'storage',
    });
    expect(resolveAppId({ search: null, stored: null, env: '789' })).toEqual({
      appId: '789',
      source: 'env',
    });
  });

  it('falls through to none when nothing is set', () => {
    expect(resolveAppId({})).toEqual({ appId: null, source: 'none' });
  });

  it('ignores values that are not numeric ids', () => {
    expect(resolveAppId({ search: '?app=drop%20table', stored: 'abc', env: ' ' })).toEqual({
      appId: null,
      source: 'none',
    });
    expect(resolveAppId({ search: '?app=', stored: '42' })).toEqual({
      appId: '42',
      source: 'storage',
    });
  });
});

describe('API origin', () => {
  it('defaults to the SDK build origin with a websocket twin', () => {
    expect(API_HTTP_URL).toBe('https://ck.test.example');
    expect(API_WS_URL).toBe('wss://ck.test.example');
  });
});

describe('resolveAuthorizeUrl', () => {
  it('rewrites a loopback authorize host when the page is public', () => {
    expect(
      resolveAuthorizeUrl({
        authorizeUrl: 'http://127.0.0.1:5173/authorize',
        pageHostname: '203.0.113.8',
      }),
    ).toBe('http://203.0.113.8:5173/authorize');
  });

  it('keeps loopback when the page is also loopback', () => {
    expect(
      resolveAuthorizeUrl({
        authorizeUrl: 'http://localhost:5173/authorize?app=1',
        pageHostname: '127.0.0.1',
      }),
    ).toBe('http://localhost:5173/authorize?app=1');
  });

  it('returns undefined when nothing is set', () => {
    expect(resolveAuthorizeUrl({})).toBeUndefined();
    expect(resolveAuthorizeUrl({ authorizeUrl: '  ' })).toBeUndefined();
  });
});

describe('resolveStudioOrigin', () => {
  it('prefers an explicit Studio URL', () => {
    expect(
      resolveStudioOrigin({
        authorizeUrl: 'http://127.0.0.1:5173/authorize',
        studioUrl: 'https://studio.example/app',
        pageHostname: '203.0.113.8',
      }),
    ).toBe('https://studio.example');
  });

  it('rewrites a loopback authorize host when the page is public', () => {
    expect(
      resolveStudioOrigin({
        authorizeUrl: 'http://127.0.0.1:5173/authorize',
        pageHostname: '203.0.113.8',
      }),
    ).toBe('http://203.0.113.8:5173');
  });

  it('keeps loopback when the page is also loopback', () => {
    expect(
      resolveStudioOrigin({
        authorizeUrl: 'http://localhost:5173/authorize',
        pageHostname: '127.0.0.1',
      }),
    ).toBe('http://localhost:5173');
  });

  it('returns null when nothing can be derived', () => {
    expect(resolveStudioOrigin({})).toBeNull();
    expect(resolveStudioOrigin({ authorizeUrl: 'not-a-url' })).toBeNull();
  });
});
