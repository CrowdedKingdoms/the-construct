/**
 * Sign-in for a game on its own domain: HOSTED, always.
 *
 * The player is sent to Crowded Kingdoms' sign-in page (Studio's `/authorize`)
 * with a PKCE challenge and comes back with a token confined to this app. This
 * page never sees a password and never holds an identity session -- the direct
 * sign-in mutations are refused from any browser origin that is not Crowded
 * Kingdoms' own (`HOSTED_SIGN_IN_REQUIRED`, ck-api v1.88.0). The reason is the
 * player's password: a form here that collected it would be indistinguishable,
 * to the platform and to the player, from a phishing page.
 *
 * What this means for a third-party game:
 *  - there is no login form, register form, magic link or guest account in the
 *    browser. Account creation happens on Studio's page during the redirect.
 *  - the app id must be known BEFORE sign-in (the redirect names it). It comes
 *    from `VITE_APP_ID`, `?app=`, or this browser's storage; `npm run setup`
 *    creates the app and prints the id.
 *  - this page's origin must be one of the app's registered redirect URIs.
 *    `npm run setup` registers the dev server's; add the production origin in
 *    Studio > Apps > Settings > Sign-in & redirect URIs.
 */
import { NetworkManager, type AppRoute } from '@/platform/network/NetworkManager';

export class AuthService {
  constructor(private readonly network: NetworkManager = NetworkManager.instance) {}

  /** Leave for Crowded Kingdoms' sign-in page; the browser navigates away. */
  async signIn(appId: string): Promise<void> {
    await this.network.signInHosted(appId);
  }

  /** Finish a sign-in this page is returning from, if any. */
  async completeIfReturning(): Promise<AppRoute | null> {
    return this.network.completeHostedSignInIfPresent();
  }

  /** A previous visit's token and route, if they still work. */
  async restore(): Promise<AppRoute | null> {
    return this.network.restore();
  }

  async signOut(): Promise<void> {
    await this.network.signOut();
  }
}
