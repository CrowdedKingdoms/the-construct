/**
 * Sign-in: password (register or log in), magic link, or a guest account.
 * Resolves with the signed-in user; the boot flow decides what happens next.
 */
import type { AuthService } from '@/platform/auth/AuthService';
import type { SessionUser } from '@/platform/network/NetworkManager';
import type { BootCard } from '@/ui/BootCard';
import { el, messageOf } from '@/ui/dom';

type Mode = 'login' | 'register' | 'magic';

export function showLoginForm(card: BootCard, auth: AuthService): Promise<SessionUser> {
  return new Promise((resolve) => {
    let mode: Mode = auth.rememberedEmail() ? 'login' : 'register';
    const error = el('p', { class: 'error-text' });
    const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    email.value = auth.rememberedEmail() ?? '';
    const password = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
    const gamertag = el('input', { type: 'text', autocomplete: 'nickname', placeholder: 'Shown above your avatar' });
    const passwordField = el('div', {}, [el('label', { text: 'Password' }), password]);
    const gamertagField = el('div', {}, [el('label', { text: 'Gamertag (optional)' }), gamertag]);
    const submit = el('button', { class: 'primary', type: 'submit' });
    const guest = el('button', { class: 'ghost', type: 'button', text: 'Continue as guest' });
    const tabs: Record<Mode, HTMLButtonElement> = {
      register: el('button', { type: 'button', text: 'Create account', role: 'tab' }),
      login: el('button', { type: 'button', text: 'Sign in', role: 'tab' }),
      magic: el('button', { type: 'button', text: 'Email me a link', role: 'tab' }),
    };

    const render = () => {
      for (const [key, tab] of Object.entries(tabs)) tab.setAttribute('aria-selected', String(key === mode));
      passwordField.classList.toggle('hidden', mode === 'magic');
      gamertagField.classList.toggle('hidden', mode !== 'register');
      password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      submit.textContent = mode === 'register' ? 'Create account' : mode === 'login' ? 'Sign in' : 'Send link';
      error.textContent = '';
    };
    for (const [key, tab] of Object.entries(tabs)) {
      tab.addEventListener('click', () => {
        mode = key as Mode;
        render();
      });
    }

    const busy = (on: boolean) => {
      submit.disabled = on;
      guest.disabled = on;
    };

    const form = el('form', {}, [
      el('div', { class: 'tabs', role: 'tablist' }, [tabs.register, tabs.login, tabs.magic]),
      el('label', { text: 'Email' }),
      email,
      passwordField,
      gamertagField,
      error,
      el('div', { class: 'actions' }, [submit, guest]),
      el('p', { class: 'muted', style: 'font-size:12px;margin:14px 0 0' }, [
        'Accounts live on Crowded Kingdoms, not in this repo. A guest account is remembered only in this browser; ',
        'clearing site data loses it.',
      ]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(true);
      error.textContent = '';
      try {
        if (mode === 'magic') {
          await auth.requestMagicLink(email.value);
          card.setStatus('Check your inbox');
          error.textContent = '';
          form.replaceChildren(
            el('p', {}, [`If ${email.value.trim()} can sign in, a link is on its way. Open it in this browser.`]),
          );
          return;
        }
        const user =
          mode === 'register'
            ? await auth.register(email.value, password.value, gamertag.value)
            : await auth.signIn(email.value, password.value);
        resolve(user);
      } catch (err) {
        error.textContent = friendlyAuthError(err);
      } finally {
        busy(false);
      }
    });

    guest.addEventListener('click', async () => {
      busy(true);
      error.textContent = '';
      try {
        resolve(await auth.continueAsGuest());
      } catch (err) {
        error.textContent = messageOf(err);
      } finally {
        busy(false);
      }
    });

    card.setStatus('Sign in to enter The Construct');
    card.show(form);
    render();
    email.focus();
  });
}

function friendlyAuthError(error: unknown): string {
  const text = messageOf(error);
  if (/UNAUTHENTICATED|invalid credentials|Unauthorized/i.test(text)) return 'Wrong email or password.';
  if (/already/i.test(text)) return 'That email already has an account — use Sign in.';
  if (/password/i.test(text) && /confirm|unconfirmed/i.test(text)) {
    return 'This account needs its email confirmed before password sign-in. Try the magic link.';
  }
  return text;
}
