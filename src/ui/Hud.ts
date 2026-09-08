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
  /** Turn the local webcam on/off (also bound to B). */
  toggleCamera(): void;
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
  private readonly cameraButton: HTMLButtonElement;
  private readonly preview: HTMLVideoElement;
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
    this.banner = el('div', { class: 'panel banner hidden', role: 'note' }, [
      this.bannerText,
      dismiss,
    ]);

    const studio = el('button', {
      text: 'Crowdy Studio (M)',
      title: 'Open Crowdy Studio on the grid you stand on',
    });
    studio.addEventListener('click', actions.openStudio);
    const setup = el('button', {
      text: 'Switch app',
      title: 'Play a different app (a fresh sign-in for it)',
    });
    setup.addEventListener('click', actions.openSetup);
    const camera = el('button', {
      text: 'Camera (B)',
      title: 'Share your webcam with players nearby (needs use_video_chat)',
    }) as HTMLButtonElement;
    camera.addEventListener('click', actions.toggleCamera);
    this.cameraButton = camera;
    const signOut = el('button', { class: 'ghost', text: 'Sign out' });
    signOut.addEventListener('click', actions.signOut);
    // The local self-preview: shown while the camera is live, never on the
    // player's own avatar (they cannot see it anyway).
    this.preview = el('video', {
      class: 'camera-preview hidden',
      title: 'Your camera, as others see it',
    }) as HTMLVideoElement;
    this.preview.muted = true;
    this.preview.autoplay = true;
    this.preview.playsInline = true;

    this.root = el('div', {}, [
      el('div', { class: 'hud-top-left' }, [this.identity, this.world, this.studioChip]),
      el('div', { class: 'hud-top-right' }, [camera, studio, setup, signOut]),
      this.hint,
      this.toasts,
      this.banner,
      this.preview,
    ]);
    parent.appendChild(this.root);
  }

  /** Reflect the local camera state on the button and the self-preview. */
  renderCamera(state: { live: boolean; stream: MediaStream | null; error: string | null }): void {
    this.cameraButton.textContent = state.live ? 'Camera on (B)' : 'Camera (B)';
    this.cameraButton.classList.toggle('active', state.live);
    if (state.live && state.stream) {
      this.preview.srcObject = state.stream;
      this.preview.classList.remove('hidden');
    } else {
      this.preview.srcObject = null;
      this.preview.classList.add('hidden');
    }
    if (state.error) this.toast(state.error, 'warn');
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
      el('div', { class: 'row' }, [
        el('strong', { text: session.displayName }),
        el('span', { class: 'muted', text: user?.email ?? '' }),
      ]),
      el('div', { class: 'row muted' }, [
        `app ${session.network.appId ?? '—'}`,
        `· ${extras.sceneId}`,
        `· ${extras.players} nearby`,
      ]),
    );
    const worldRows: Node[] = [];
    if (!model) worldRows.push(el('div', { class: 'muted', text: 'reading the game model…' }));
    else {
      if (model.pulses !== undefined)
        worldRows.push(el('div', { text: `world pulses ${model.pulses}` }));
      if (model.level !== undefined) worldRows.push(el('div', { text: `level ${model.level}` }));
      if (worldRows.length === 0)
        worldRows.push(el('div', { class: 'muted', text: 'model not seeded — run npm run setup' }));
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
      el('div', { class: 'row' }, [
        el('strong', { text: state.open ? 'Studio open' : 'Studio' }),
        el('span', { class: 'muted', text: grid }),
      ]),
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
