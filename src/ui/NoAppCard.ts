/**
 * Shown when the page does not know which app it is. The browser cannot create
 * one: that needs an identity session, which a game on its own domain never
 * holds (see `AuthService`). The developer runs Setup from a shell, or creates
 * the app in Studio, and tells this checkout the id.
 */
import type { BootCard } from '@/ui/BootCard';
import { el } from '@/ui/dom';

export function showNoApp(card: BootCard, onAppId: (appId: string) => void, reason?: string): void {
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    placeholder: 'App id, e.g. 88697271312640',
    autocomplete: 'off',
  });
  const error = el('p', { class: 'error-text' });
  const go = el('button', { class: 'primary', type: 'submit', text: 'Use this app' });
  const form = el('form', {}, [
    reason ? el('p', { class: 'error-text', text: reason }) : el('span'),
    el('p', {}, [
      'This checkout is not pinned to a Crowded Kingdoms app yet. Create one and its game model from a shell:',
    ]),
    el('pre', { class: 'code' }, [
      'CONSTRUCT_EMAIL=you@example.com CONSTRUCT_PASSWORD=... \\\n' +
        '  npm run setup -- --org "My studio" --app "The Construct"',
    ]),
    el('p', {}, [
      'Setup creates the org and app, seeds the model, registers this dev server as a redirect URI, ',
      'and prints the app id. Put it in ',
      el('code', { text: '.env.local' }),
      ' as ',
      el('code', { text: 'VITE_APP_ID' }),
      ' -- or paste it here for this browser only:',
    ]),
    el('label', { text: 'App id' }),
    input,
    error,
    el('div', { class: 'actions' }, [go]),
    el('p', { class: 'muted', style: 'font-size:12px;margin:14px 0 0' }, [
      'Already have an app in Studio? Add this origin under Apps > Settings > Sign-in & redirect URIs, then use its id.',
    ]),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!/^\d{1,20}$/.test(value)) {
      error.textContent = 'An app id is a number.';
      return;
    }
    onAppId(value);
  });
  card.setStatus('Which app is this?');
  card.show(form);
  input.focus();
}
