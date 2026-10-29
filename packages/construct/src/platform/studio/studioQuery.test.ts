import { describe, expect, it } from 'vitest';
import { requestedProject, wantsStudioOpen } from './studioQuery';

describe('wantsStudioOpen', () => {
  it('opens for the live-code query and for a page that says nothing', () => {
    expect(wantsStudioOpen('?app=1&studio=open')).toBe(true);
    expect(wantsStudioOpen('')).toBe(true);
    expect(wantsStudioOpen('?studio=closed')).toBe(false);
  });
});

describe('requestedProject', () => {
  it('reads an id-shaped project and ignores anything else', () => {
    expect(requestedProject('?app=1&studio=open&project=129481')).toBe('129481');
    expect(requestedProject('?project=')).toBeNull();
    expect(requestedProject('?project=../../etc')).toBeNull();
    expect(requestedProject('')).toBeNull();
  });
});
