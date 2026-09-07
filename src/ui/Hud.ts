/**
 * The in-game HUD: who/where chips, hint line, toasts, the client-mods
 * banner, and the top-right actions. DOM only; scenes talk to it through the
 * `SceneHud` interface and never reach into it.
 */
import type { SceneHud } from '@/engine/GameScene';
import type { GameSession } from '@/platform/GameSession';
import type { StudioState } from '@/platform/studio/StudioService';
import { el } from '@/ui/dom';

export interface HudActions {
  openStudio(): void;
  openSetup(): void;
  signOut(): void;
}

export class Hud implements SceneHud {
  readonly root: HTMLElement;
  private readonly identity: HTMLElement;
  private readonly world: HTMLElement;
  private readonly studioChip: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerText: HTMLElement;
  private bannerDismissed = false;
  private lastModel: { pulses?: number; level?: number } | null = null;

  constructor(parent: HTMLElement, actions: HudActions) {
    this.identity = el('div', { class: 'panel chip' });
    this.world = el('div', { class: 'panel chip' });
    this.studioChip = el('div', { class: 'panel chip' });
    this.hint = el('div', { class: 'panel hud-hint hidden', role: 'status' });
    this.toasts = el('div', { class: 'toasts', 'aria-live': 'polite' });
    this.bannerText = el('span');
    const dismiss = el('button', { text: 'Dismiss' });
    dismiss.addEventListener('click', () => {
      this.bannerDismissed = true;
      this.banner.classList.add('hidden');
    });
    this.banner = el('div', { class: 'panel banner hidden', role: 'note' }, [this.bannerText, dismiss]);

    const studio = el('button', { text: 'Crowdy Studio (M)', title: 'Open Crowdy Studio on the grid you stand on' });
    studio.addEventListener('click', actions.openStudio);
    const setup = el('button', { text: 'Setup', title: 'Create or switch apps; re-run the model seed' });
    setup.addEventListener('click', actions.openSetup);
    const signOut = el('button', { class: 'ghost', text: 'Sign out' });
    signOut.addEventListener('click', actions.signOut);

    this.root = el('div', {}, [
      el('div', { class: 'hud-top-left' }, [this.identity, this.world, this.studioChip]),
      el('div', { class: 'hud-top-right' }, [studio, setup, signOut]),
      this.hint,
      this.toasts,
      this.banner,
    ]);
    parent.appendChild(this.root);
  }

  setHint(text: string | null): void {
    this.hint.textContent = text ?? '';
    this.hint.classList.toggle('hidden', !text);
  }

  toast(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    const node = el('div', { class: 'panel toast', 'data-tone': tone, text });
    this.toasts.appendChild(node);
    setTimeout(() => node.remove(), tone === 'error' ? 7000 : 3500);
  }

  /** Refresh the chips from the session (called on a slow interval). */
  render(
    session: GameSession,
    extras: { players: number; sceneId: string; model?: { pulses?: number; level?: number } },
  ): void {
    const user = session.network.user;
    // Presence refreshes often; model reads rarely. Keep the last model answer
    // so a presence-only render does not blank the world row.
    if (extras.model) this.lastModel = extras.model;
    const model = this.lastModel;
    this.identity.replaceChildren(
      el('div', { class: 'row' }, [el('strong', { text: session.displayName }), el('span', { class: 'muted', text: user?.email ?? '' })]),
      el('div', { class: 'row muted' }, [
        `app ${session.network.appId ?? '—'}`,
        `· ${extras.sceneId}`,
        `· ${extras.players} nearby`,
      ]),
    );
    const worldRows: Node[] = [];
    if (!model) worldRows.push(el('div', { class: 'muted', text: 'reading the game model…' }));
    else {
      if (model.pulses !== undefined) worldRows.push(el('div', { text: `world pulses ${model.pulses}` }));
      if (model.level !== undefined) worldRows.push(el('div', { text: `level ${model.level}` }));
      if (worldRows.length === 0) worldRows.push(el('div', { class: 'muted', text: 'model not seeded — run Setup' }));
    }
    this.world.replaceChildren(...worldRows);
  }

  renderStudio(state: StudioState): void {
    const grid = state.grid
      ? `grid ${state.grid.gridId}${state.grid.owned ? ' (yours)' : ''}`
      : 'no grid here';
    const perms = state.grid
      ? `S ${flag(state.grid.permissions.server)} · C ${flag(state.grid.permissions.client)}`
      : '';
    const mods = state.clientModsAvailable
      ? `client mods on${state.clientModsRunning ? ` · ${state.clientModsRunning} running` : ''}`
      : 'client mods off';
    this.studioChip.replaceChildren(
      el('div', { class: 'row' }, [el('strong', { text: state.open ? 'Studio open' : 'Studio' }), el('span', { class: 'muted', text: grid })]),
      el('div', { class: 'row muted' }, [perms ? `${perms} · ` : '', mods]),
    );
    if (state.clientModsReason && !this.bannerDismissed) {
      this.bannerText.textContent = state.clientModsReason;
      this.banner.classList.remove('hidden');
    } else {
      this.banner.classList.add('hidden');
    }
  }
}

function flag(p: { canWrite: boolean; canRun: boolean }): string {
  return `${p.canWrite ? 'w' : '-'}${p.canRun ? 'r' : '-'}`;
}
