/**
 * The sign-in card: one button that leaves for Crowded Kingdoms' hosted
 * sign-in. There is no form here on purpose -- see `AuthService`.
 */
import type { AuthService } from '@/platform/auth/AuthService';
import type { BootCard } from '@/ui/BootCard';
import { el, messageOf } from '@/ui/dom';

export function showSignIn(card: BootCard, auth: AuthService, appId: string): void {
  const error = el('p', { class: 'error-text' });
  const button = el('button', {
    class: 'primary',
    type: 'button',
    text: 'Sign in with Crowded Kingdoms',
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    error.textContent = '';
    try {
      await auth.signIn(appId);
      // The page is navigating away; if it is still here in a moment, say so.
      setTimeout(() => {
        button.disabled = false;
      }, 4000);
    } catch (err) {
      button.disabled = false;
      error.textContent = messageOf(err);
    }
  });

  card.setStatus('Sign in to enter The Construct');
  card.show([
    el('p', {}, [
      'You will sign in (or create an account) on Crowded Kingdoms and come straight back. ',
      'This game only ever receives a token for itself -- never your password.',
    ]),
    error,
    el('div', { class: 'actions' }, [button]),
    el('p', { class: 'muted', style: 'font-size:12px;margin:14px 0 0' }, [
      `App ${appId}. `,
      'If the sign-in page says this address is not registered, the developer adds ',
      `${typeof window === 'undefined' ? 'this origin' : window.location.origin} `,
      'under Studio > Apps > Settings > Sign-in & redirect URIs.',
    ]),
  ]);
  button.focus();
}
