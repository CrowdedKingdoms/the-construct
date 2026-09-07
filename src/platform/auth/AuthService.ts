/**
 * Sign-in for a game that owns its own login screen.
 *
 * Three routes, all yielding the identity session the NetworkManager holds:
 *  - email + password (`register` on first visit, `login` afterwards),
 *  - a magic link emailed to the player (completes on the redirect back),
 *  - a **guest** account: random credentials generated here and remembered in
 *    this browser only. Convenient for trying the game; the README says out
 *    loud that clearing site data loses a guest account.
 *
 * The Overworld PKCE portal (`portal.beginEntry` / `completeEntry`) is the
 * alternative used by first-party games behind a shared lobby; it is
 * documented in docs/PLATFORM-MAP.md and not wired here, because a third-party
 * game has no Overworld to hand off to.
 */
import { isAlreadyRegisteredError } from '@crowdedkingdoms/crowdyjs';

import { readScoped, writeScoped } from '@/platform/envScope';
import { NetworkManager, messageOf, type SessionUser } from '@/platform/network/NetworkManager';

const GUEST_KEY = 'construct:guest-credentials';
const REMEMBERED_EMAIL_KEY = 'construct:remembered-email';

interface GuestCredentials {
  email: string;
  password: string;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

export class AuthService {
  constructor(private readonly network: NetworkManager = NetworkManager.instance) {}

  rememberedEmail(): string | null {
    return readScoped(REMEMBERED_EMAIL_KEY);
  }

  hasGuest(): boolean {
    return readScoped(GUEST_KEY) !== null;
  }

  /** Sign in; on "unknown account" offer nothing clever — the UI shows register. */
  async signIn(email: string, password: string): Promise<SessionUser> {
    const user = await this.network.login(email, password);
    writeScoped(REMEMBERED_EMAIL_KEY, email.trim().toLowerCase());
    return user;
  }

  /** Register, falling back to login when the address already has an account. */
  async register(email: string, password: string, gamertag?: string): Promise<SessionUser> {
    try {
      const user = await this.network.register(email, password, gamertag);
      writeScoped(REMEMBERED_EMAIL_KEY, email.trim().toLowerCase());
      return user;
    } catch (error) {
      if (isAlreadyRegisteredError(error)) return this.signIn(email, password);
      throw error;
    }
  }

  async requestMagicLink(email: string): Promise<void> {
    await this.network.requestMagicLink(email);
    writeScoped(REMEMBERED_EMAIL_KEY, email.trim().toLowerCase());
  }

  /** A throwaway account for this browser; persists until site data is cleared. */
  async continueAsGuest(): Promise<SessionUser> {
    let creds = this.loadGuest();
    if (!creds) {
      creds = {
        email: `guest-${randomHex(10)}@construct.invalid`,
        password: `Guest-${randomHex(20)}!`,
      };
      writeScoped(GUEST_KEY, JSON.stringify(creds));
    }
    try {
      return await this.network.register(creds.email, creds.password, `guest-${randomHex(4)}`);
    } catch (error) {
      if (isAlreadyRegisteredError(error)) return this.network.login(creds.email, creds.password);
      throw new Error(`Guest sign-in failed: ${messageOf(error)}`, { cause: error });
    }
  }

  async signOut(): Promise<void> {
    await this.network.signOut();
  }

  private loadGuest(): GuestCredentials | null {
    const raw = readScoped(GUEST_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<GuestCredentials>;
      return parsed.email && parsed.password
        ? { email: parsed.email, password: parsed.password }
        : null;
    } catch {
      return null;
    }
  }
}
