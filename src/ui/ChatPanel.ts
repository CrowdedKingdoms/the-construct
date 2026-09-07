/**
 * Proximity chat panel. `T` or Enter focuses the box (gameplay keys are
 * suppressed while typing); Escape blurs it.
 */
import type { Input } from '@/engine/Input';
import type { ChatMessage, ChatService } from '@/platform/social/ChatService';
import { el } from '@/ui/dom';

export class ChatPanel {
  readonly root: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly inputBox: HTMLInputElement;
  private release: (() => void) | null = null;
  private disposers: Array<() => void> = [];

  constructor(parent: HTMLElement, chat: ChatService, input: Input) {
    this.messages = el('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
    this.inputBox = el('input', {
      type: 'text',
      placeholder: 'Say something nearby (T)',
      maxlength: '240',
      autocomplete: 'off',
    });
    const send = el('button', { type: 'submit', text: 'Send' });
    const form = el('form', {}, [this.inputBox, send]);
    this.root = el('div', { class: 'panel chat' }, [this.messages, form]);
    parent.appendChild(this.root);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.inputBox.value;
      this.inputBox.value = '';
      if (text.trim())
        void chat.send(text).catch((error) => chat.system(`send failed: ${String(error)}`));
      this.inputBox.blur();
    });
    this.inputBox.addEventListener('focus', () => {
      this.release?.();
      this.release = input.suppress();
    });
    this.inputBox.addEventListener('blur', () => {
      this.release?.();
      this.release = null;
    });
    this.inputBox.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.inputBox.blur();
      event.stopPropagation();
    });
    this.disposers.push(
      input.onKey('KeyT', (event) => {
        if (input.suppressed) return;
        event.preventDefault();
        this.inputBox.focus();
      }),
    );
    this.disposers.push(chat.events.on('message', (message) => this.append(message)));
    for (const message of chat.messages()) this.append(message);
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.root.remove();
  }

  private append(message: ChatMessage): void {
    const node = el(
      'div',
      { class: `msg${message.self ? ' self' : ''}${message.uuid ? '' : ' system'}` },
      [
        message.uuid ? el('span', { class: 'who', text: `${message.name}: ` }) : null,
        el('span', { text: message.text }),
      ],
    );
    this.messages.appendChild(node);
    while (this.messages.childElementCount > 120) this.messages.firstElementChild?.remove();
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}
