import { describe, expect, it } from 'vitest';
import { wantsStudioOpen } from './studioQuery';

describe('wantsStudioOpen', () => {
  it('opens for the live-code query and for a page that says nothing', () => {
    expect(wantsStudioOpen('?app=1&studio=open')).toBe(true);
    expect(wantsStudioOpen('')).toBe(true);
    expect(wantsStudioOpen('?studio=closed')).toBe(false);
  });
});
