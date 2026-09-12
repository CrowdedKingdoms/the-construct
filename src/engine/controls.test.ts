import { describe, expect, it } from 'vitest';

import { Controls, helpLines, isControl } from '@/engine/controls';

describe('controls', () => {
  it('maps chat to T and both Enters, and activate to E only', () => {
    expect(isControl('chat', 'KeyT')).toBe(true);
    expect(isControl('chat', 'Enter')).toBe(true);
    expect(isControl('chat', 'NumpadEnter')).toBe(true);
    expect(isControl('activate', 'KeyE')).toBe(true);
    expect(isControl('activate', 'Enter')).toBe(false);
    expect(Controls.voice).toContain('KeyV');
    expect(Controls.webcam).toContain('KeyB');
  });

  it('lists holodeck look/zoom and paint pan without mixing them', () => {
    const holodeck = helpLines('holodeck').join('\n');
    const paint = helpLines('paint').join('\n');
    expect(holodeck).toMatch(/right mouse/);
    expect(holodeck).toMatch(/Scroll/);
    expect(holodeck).toMatch(/E — activate/);
    expect(paint).toMatch(/middle-drag/);
    expect(paint).not.toMatch(/activate a pad/);
  });
});
