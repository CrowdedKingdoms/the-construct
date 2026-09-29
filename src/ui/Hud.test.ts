import { describe, expect, it, vi } from 'vitest';

import { Hud, type HudActions } from './Hud';

function studioState(clientHalves: unknown[]) {
  return {
    open: false,
    grid: null,
    clientModsAvailable: true,
    clientModsRunning: clientHalves.length,
    clientHalves,
    clientModsReason: null,
    agentReady: false,
    agentReason: null,
  } as never;
}

function hud() {
  const actions: HudActions = {
    openStudio: vi.fn(),
    openSetup: vi.fn(),
    signOut: vi.fn(),
    toggleCamera: vi.fn(),
    toggleVoice: vi.fn(),
    stopClientHalf: vi.fn(),
    forgetClientHalfAuthor: vi.fn(),
  };
  const parent = document.createElement('div');
  const view = new Hud(parent, actions);
  return { view, parent, actions };
}

describe('the CLIENT halves running here', () => {
  it('offer Stop for each and Forget author for someone else’s, wired to the studio', () => {
    const { view, parent, actions } = hud();
    view.renderStudio(
      studioState([
        { modId: '900', name: 'plot-hud', authorId: '7', authorName: 'trinity', own: false },
        { modId: '901', name: 'mine', authorId: '3', authorName: null, own: true },
      ]),
    );
    const group = parent.querySelector('.client-halves')!;
    expect(group.classList.contains('hidden')).toBe(false);
    expect(group.textContent).toContain('plot-hud by trinity');
    expect(group.textContent).toContain('mine by you');

    parent.querySelector<HTMLButtonElement>('[data-client-half-stop="900"]')!.click();
    expect(actions.stopClientHalf).toHaveBeenCalledWith('900');
    parent.querySelector<HTMLButtonElement>('[data-client-half-forget="7"]')!.click();
    expect(actions.forgetClientHalfAuthor).toHaveBeenCalledWith('7');
    expect(parent.querySelector('[data-client-half-forget="3"]')).toBeNull();
  });

  it('shows a half’s name as text and hides the group when nothing runs', () => {
    const { view, parent } = hud();
    view.renderStudio(
      studioState([
        {
          modId: '1',
          name: '<img src=x onerror=alert(1)>',
          authorId: '7',
          authorName: null,
          own: false,
        },
      ]),
    );
    expect(parent.querySelector('.client-halves img')).toBeNull();
    expect(parent.querySelector('.client-halves')!.textContent).toContain('<img src=x');
    view.renderStudio(studioState([]));
    expect(parent.querySelector('.client-halves')!.classList.contains('hidden')).toBe(true);
  });
});
