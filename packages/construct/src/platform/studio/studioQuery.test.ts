import { beforeEach, describe, expect, it } from 'vitest';
import { envScopedKey } from '../envScope';
import { rememberRequestedProject, requestedProject, wantsStudioOpen } from './studioQuery';

const KEPT = envScopedKey('construct:requested-project');

describe('wantsStudioOpen', () => {
  it('opens for the live-code query and for a page that says nothing', () => {
    expect(wantsStudioOpen('?app=1&studio=open')).toBe(true);
    expect(wantsStudioOpen('')).toBe(true);
    expect(wantsStudioOpen('?studio=closed')).toBe(false);
  });
});

describe('requestedProject', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads an id-shaped project and ignores anything else', () => {
    expect(requestedProject('?app=1&studio=open&project=129481')).toBe('129481');
    expect(requestedProject('?project=')).toBeNull();
    expect(requestedProject('?project=../../etc')).toBeNull();
    expect(requestedProject('')).toBeNull();
  });

  it('opens the remembered project once after a sign-in returns to the bare address', () => {
    rememberRequestedProject('?app=1&studio=open&project=129481');
    // The sign-in return: the address carries only the code and state.
    rememberRequestedProject('?code=c&state=s');
    expect(requestedProject('?code=c&state=s')).toBe('129481');
    expect(requestedProject('')).toBeNull();
  });

  it('prefers the address to a remembered project, and uses the remembered one up', () => {
    rememberRequestedProject('?project=older');
    expect(requestedProject('?project=newer')).toBe('newer');
    expect(sessionStorage.getItem(KEPT)).toBeNull();
  });

  it('keeps only an id-shaped project, and never opens a tampered one', () => {
    rememberRequestedProject('?project=..%2F..%2Fetc');
    rememberRequestedProject('?project=');
    expect(sessionStorage.getItem(KEPT)).toBeNull();
    sessionStorage.setItem(KEPT, '<img src=x>');
    expect(requestedProject('')).toBeNull();
    expect(sessionStorage.getItem(KEPT)).toBeNull();
  });

  it('carries on without storage', () => {
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => rememberRequestedProject('?project=129481', denied)).not.toThrow();
    expect(requestedProject('?project=129481', denied)).toBe('129481');
    expect(requestedProject('', denied)).toBeNull();
    expect(requestedProject('?project=129481', undefined)).toBe('129481');
  });
});
