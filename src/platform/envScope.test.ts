import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@crowdedkingdoms/crowdyjs', () => ({
  CROWDY_DEFAULT_HTTP_ORIGIN: 'https://ck.test.example',
  CROWDY_DEFAULT_TIER: 'test',
}));

const { ENV_HANDLE, envHandleFor, envScopedKey, ensureEnvScope, readScoped, writeScoped } =
  await import('@/platform/envScope');

describe('envScope', () => {
  beforeEach(() => localStorage.clear());

  it('derives a handle from the origin without inspecting hostname shape', () => {
    expect(envHandleFor('https://ck.prod.crowdedkingdoms.com')).toBe('ck.prod.crowdedkingdoms.com');
    expect(envHandleFor('http://localhost:3000')).toBe('localhost_3000');
    expect(envHandleFor('not a url')).toBe('not_a_url');
    expect(ENV_HANDLE).toBe('ck.test.example');
  });

  it('suffixes keys with the handle', () => {
    expect(envScopedKey('construct:app-id')).toBe('construct:app-id:ck.test.example');
    expect(envScopedKey('x', 'other')).toBe('x:other');
  });

  it('drops per-environment values when the environment changes', () => {
    localStorage.setItem('construct:env-handle', 'ck.old.example');
    localStorage.setItem('construct:app-id:ck.old.example', '111');
    localStorage.setItem('construct:app-id:ck.test.example', '222');
    ensureEnvScope();
    expect(localStorage.getItem('construct:app-id:ck.old.example')).toBeNull();
    expect(localStorage.getItem('construct:app-id:ck.test.example')).toBe('222');
    expect(localStorage.getItem('construct:env-handle')).toBe('ck.test.example');
  });

  it('reads and writes scoped values', () => {
    writeScoped('construct:app-id', '99');
    expect(readScoped('construct:app-id')).toBe('99');
    writeScoped('construct:app-id', null);
    expect(readScoped('construct:app-id')).toBeNull();
  });
});
