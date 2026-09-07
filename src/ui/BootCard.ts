/**
 * The centred card everything before gameplay happens in: status while the
 * session restores, the sign-in form, the Setup wizard, and any error that
 * stops the boot. One element, swapped content, so a player never sees two
 * dialogs at once.
 */
import { API_HTTP_URL, API_TIER, GAME_NAME } from '@/platform/config';
import { clear, el } from '@/ui/dom';

export class BootCard {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;

  constructor(parent: HTMLElement) {
    this.status = el('div', { class: 'status', role: 'status' });
    this.body = el('div', { class: 'body' });
    this.root = el('section', { class: 'panel boot-card', 'aria-live': 'polite' }, [
      el('h1', { text: GAME_NAME }),
      el('p', { class: 'subtitle' }, [
        `Crowded Kingdoms starter · API ${API_TIER} · `,
        el('span', { class: 'mono', text: new URL(API_HTTP_URL).host }),
      ]),
      this.status,
      this.body,
    ]);
    parent.appendChild(this.root);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Replace the card body with `content`; returns the body for wiring. */
  show(content: Node | Node[]): HTMLElement {
    clear(this.body);
    this.body.append(...(Array.isArray(content) ? content : [content]));
    this.root.classList.remove('hidden');
    return this.body;
  }

  showError(title: string, detail: string, retry?: () => void): void {
    const actions = el('div', { class: 'actions' });
    if (retry) {
      const button = el('button', { class: 'primary', text: 'Try again' });
      button.addEventListener('click', retry);
      actions.appendChild(button);
    }
    this.setStatus(title);
    this.show([el('p', { class: 'error-text', text: detail }), actions]);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}
