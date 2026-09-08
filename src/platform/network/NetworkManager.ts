/**
 * The one place this game talks to Crowded Kingdoms.
 *
 * Two clients, two tokens, one endpoint:
 *
 *  - the **identity** client holds the player's session token. It signs in,
 *    creates orgs and apps (the Setup wizard), mints app tokens, and never
 *    touches gameplay.
 *  - the **game** client holds a short-lived **app-scoped** token for ONE app
 *    and is pointed at that app's own datacenter (`mintAppToken` returns the
 *    endpoint). Everything realtime, model, Studio and persistence runs on it.
 *
 * Scenes and services never import the SDK client directly; they read
 * `NetworkManager.instance.game`. That keeps "which token, which endpoint" a
 * single decision made here, and lets the wizard rebuild the game client when
 * the player switches apps.
 */
import {
  BrowserLocalStorageTokenStore,
  createCrowdyClient,
  type CrowdyClient,
  type RealtimeStatus,
  type UdpNotification,
  type UdpNotificationHandlers,
  type UnsubscribeFn,
} from '@crowdedkingdoms/crowdyjs';

import {
  API_HTTP_URL,
  API_WS_URL,
  APP_TOKEN_REFRESH_MS,
  APP_TOKEN_REFRESH_RETRY_MS,
} from '@/platform/config';
import { envScopedKey } from '@/platform/envScope';
import { Emitter } from '@/platform/util/Emitter';

export interface SessionUser {
  userId: string;
  email?: string;
  gamertag?: string;
}

export interface AppRoute {
  appId: string;
  gameApiUrl: string | null;
  gameApiWsUrl: string | null;
  discoveryUrl: string | null;
  expiresAt: string;
}

export interface BootstrapInfo {
  minimumClientVersion?: string;
  maxReplicationDistance?: number;
  udpConnected?: boolean;
}

export interface NetworkEvents {
  auth: SessionUser | null;
  app: AppRoute | null;
  realtime: RealtimeStatus;
  log: string;
}

type UdpHandlerKind = keyof UdpNotificationHandlers;
type UdpHandler = (payload: never) => void;

function graphqlEndpoint(url: string): string {
  const trimmed = url.replace(/\/$/, '');
  return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
}

function wsTwin(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):/, (_m, secure: string) => `ws${secure}:`);
}

export class NetworkManager {
  private static singleton: NetworkManager | null = null;

  static get instance(): NetworkManager {
    if (!NetworkManager.singleton) NetworkManager.singleton = new NetworkManager();
    return NetworkManager.singleton;
  }

  /** Test seam: replace the singleton (unit tests build their own). */
  static reset(): void {
    NetworkManager.singleton?.close();
    NetworkManager.singleton = null;
  }

  readonly events = new Emitter<NetworkEvents>();

  /** Identity session client (login, orgs, apps, minting). Always present. */
  readonly identity: CrowdyClient;

  private gameClient: CrowdyClient | null = null;
  private route: AppRoute | null = null;
  private userValue: SessionUser | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshFailures = 0;
  private udpUnsubscribe: UnsubscribeFn | null = null;
  private realtimeUnsubscribe: UnsubscribeFn | null = null;
  private readonly udpHandlers = new Map<UdpHandlerKind, Set<UdpHandler>>();

  private constructor() {
    this.identity = createCrowdyClient({
      httpUrl: API_HTTP_URL,
      wsUrl: API_WS_URL,
      tokenStore: new BrowserLocalStorageTokenStore(
        envScopedKey(BrowserLocalStorageTokenStore.SESSION_KEY),
      ),
    });
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  get user(): SessionUser | null {
    return this.userValue;
  }

  get isSignedIn(): boolean {
    return Boolean(this.identity.session.getToken());
  }

  /** Restore a stored session; returns the user or null when sign-in is needed. */
  async restoreIdentity(): Promise<SessionUser | null> {
    await this.identity.session.restore();
    if (!this.identity.session.getToken()) return null;
    return this.hydrateUser();
  }

  /**
   * Finish a magic-link (`?token=`) callback if the URL carries one. Returns
   * true when a sign-in completed. The query is stripped either way.
   */
  async completeMagicLinkIfPresent(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (!token) return false;
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    try {
      await this.identity.auth.completeLoginLink(token);
      await this.hydrateUser();
      return true;
    } catch (error) {
      this.log(`Magic link sign-in failed: ${messageOf(error)}`);
      return false;
    }
  }

  async login(email: string, password: string): Promise<SessionUser> {
    await this.identity.auth.login({ email: email.trim().toLowerCase(), password });
    return this.requireUser();
  }

  async register(email: string, password: string, gamertag?: string): Promise<SessionUser> {
    await this.identity.auth.register({
      email: email.trim().toLowerCase(),
      password,
      ...(gamertag?.trim() ? { gamertag: gamertag.trim() } : {}),
    });
    return this.requireUser();
  }

  async requestMagicLink(email: string): Promise<void> {
    const redirectUri =
      typeof window === 'undefined' ? undefined : window.location.origin + window.location.pathname;
    await this.identity.auth.requestLoginLink({
      email: email.trim().toLowerCase(),
      ...(redirectUri ? { redirectUri } : {}),
    });
  }

  async signOut(): Promise<void> {
    this.leaveApp();
    try {
      await this.identity.auth.logout();
    } catch {
      this.identity.session.setToken(null);
    }
    this.userValue = null;
    this.events.emit('auth', null);
  }

  private async requireUser(): Promise<SessionUser> {
    const user = await this.hydrateUser();
    if (!user) throw new Error('Signed in, but the session could not be read back');
    return user;
  }

  private async hydrateUser(): Promise<SessionUser | null> {
    try {
      const me = await this.identity.users.me();
      if (!me) throw new Error('me() returned null');
      this.userValue = {
        userId: String(me.userId),
        email: me.email ?? undefined,
        gamertag: me.gamertag ?? undefined,
      };
      this.events.emit('auth', this.userValue);
      return this.userValue;
    } catch (error) {
      this.log(`Stored session is not valid: ${messageOf(error)}`);
      this.identity.session.setToken(null);
      this.userValue = null;
      this.events.emit('auth', null);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // App entry
  // ---------------------------------------------------------------------------

  /** The routed game client. Throws before `enterApp` has succeeded. */
  get game(): CrowdyClient {
    if (!this.gameClient) throw new Error('No app entered yet — call enterApp(appId) first');
    return this.gameClient;
  }

  get hasGame(): boolean {
    return this.gameClient !== null;
  }

  get appId(): string | null {
    return this.route?.appId ?? null;
  }

  get appRoute(): AppRoute | null {
    return this.route;
  }

  /**
   * Mint an app-scoped token and build the game client on the app's own
   * endpoint. Idempotent for the same app; switches cleanly for another.
   */
  async enterApp(appId: string): Promise<AppRoute> {
    if (!this.isSignedIn) throw new Error('Sign in before entering an app');
    if (this.route && this.route.appId !== appId) this.leaveApp();

    const minted = await this.identity.portal.mintAppToken(appId);
    const route: AppRoute = {
      appId: String(minted.appId ?? appId),
      gameApiUrl: minted.gameApiUrl ?? null,
      gameApiWsUrl: minted.gameApiWsUrl ?? null,
      discoveryUrl: minted.discoveryUrl ?? null,
      expiresAt: minted.expiresAt,
    };

    const httpUrl = route.gameApiUrl ?? API_HTTP_URL;
    const wsUrl = route.gameApiWsUrl ?? wsTwin(httpUrl);
    if (!this.gameClient || !this.route || this.route.gameApiUrl !== route.gameApiUrl) {
      this.disposeGameClient();
      this.gameClient = createCrowdyClient({
        httpUrl,
        wsUrl,
        graphqlEndpoint: graphqlEndpoint(httpUrl),
        wsEndpoint: graphqlEndpoint(wsUrl),
        tokenStore: new BrowserLocalStorageTokenStore(envScopedKey(`crowdyjs:app:${route.appId}`)),
        realtime: {
          retryAttempts: 8,
          retryInitialDelayMs: 250,
          retryMaxDelayMs: 5_000,
          waitTimeoutMs: 5_000,
          // ALWAYS the shared origin, never the per-instance URL above: a
          // token-holding client cannot re-mint, so when its instance dies
          // it must be able to ask a name that always answers.
          discoveryUrl: route.discoveryUrl ?? API_HTTP_URL,
        },
      });
      this.realtimeUnsubscribe = this.gameClient.realtime.onStatus((status) =>
        this.events.emit('realtime', status),
      );
    }
    this.gameClient.setToken(minted.token);
    this.route = route;
    this.refreshFailures = 0;
    this.scheduleRefresh(APP_TOKEN_REFRESH_MS);
    this.log(`Entered app ${route.appId} via ${httpUrl}`);
    this.events.emit('app', route);
    return route;
  }

  /** Version floor, spatial limits and the UDP proxy status for this app. */
  async bootstrap(): Promise<BootstrapInfo> {
    const appId = this.requireAppId();
    const boot = await this.game.serverStatus.gameClientBootstrap(appId);
    const min = boot.versionInfo?.minimumClientVersion;
    return {
      minimumClientVersion: min ? `${min.major}.${min.minor}.${min.patch}.${min.build}` : undefined,
      maxReplicationDistance: boot.maxReplicationDistance ?? undefined,
      udpConnected: boot.udpProxyConnectionStatus?.connected ?? undefined,
    };
  }

  leaveApp(): void {
    this.clearRefresh();
    this.disposeGameClient();
    this.route = null;
    this.events.emit('app', null);
  }

  private requireAppId(): string {
    if (!this.route) throw new Error('No app entered');
    return this.route.appId;
  }

  private disposeGameClient(): void {
    this.udpUnsubscribe?.();
    this.udpUnsubscribe = null;
    this.realtimeUnsubscribe?.();
    this.realtimeUnsubscribe = null;
    this.gameClient?.close();
    this.gameClient = null;
  }

  // ---------------------------------------------------------------------------
  // Token rotation
  // ---------------------------------------------------------------------------

  private scheduleRefresh(delayMs: number): void {
    this.clearRefresh();
    this.refreshTimer = setTimeout(() => void this.rotateAppToken(), delayMs);
  }

  private clearRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Rotate the app token while gameplay is live. The SDK disconnects the
   * old-token UDP proxy, refreshes, and reconnects with handlers intact. If the
   * refresh path itself fails twice, fall back to re-minting from the identity
   * session (which the SDK cannot do on its own — it only has the app token).
   */
  private async rotateAppToken(): Promise<void> {
    if (!this.gameClient || !this.route) return;
    try {
      const refreshed = await this.gameClient.refreshGameplayToken();
      this.route = { ...this.route, expiresAt: refreshed.expiresAt };
      this.refreshFailures = 0;
      this.log('App token rotated');
      this.scheduleRefresh(APP_TOKEN_REFRESH_MS);
    } catch (error) {
      this.refreshFailures += 1;
      this.log(`App token rotation failed (${this.refreshFailures}): ${messageOf(error)}`);
      if (this.refreshFailures >= 2 && this.isSignedIn) {
        try {
          const minted = await this.identity.portal.mintAppToken(this.route.appId);
          this.gameClient.setToken(minted.token);
          this.route = { ...this.route, expiresAt: minted.expiresAt };
          this.refreshFailures = 0;
          await this.gameClient.udp.connect().catch(() => undefined);
          this.log('App token re-minted from the identity session');
          this.scheduleRefresh(APP_TOKEN_REFRESH_MS);
          return;
        } catch (mintError) {
          this.log(`Re-mint failed: ${messageOf(mintError)}`);
        }
      }
      this.scheduleRefresh(APP_TOKEN_REFRESH_RETRY_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Realtime fan-out (for lanes World Stores do not own: chat, events, errors)
  // ---------------------------------------------------------------------------

  on<K extends keyof UdpNotificationHandlers>(
    kind: K,
    handler: NonNullable<UdpNotificationHandlers[K]>,
  ): UnsubscribeFn {
    let set = this.udpHandlers.get(kind);
    if (!set) {
      set = new Set();
      this.udpHandlers.set(kind, set);
    }
    set.add(handler as UdpHandler);
    this.ensureUdpSubscription();
    return () => {
      set?.delete(handler as UdpHandler);
    };
  }

  private ensureUdpSubscription(): void {
    if (this.udpUnsubscribe || !this.gameClient || !this.route) return;
    const dispatch = (kind: UdpHandlerKind) => (payload: unknown) => {
      const set = this.udpHandlers.get(kind);
      if (!set) return;
      // A handler that throws must never unwind into the socket's onmessage:
      // graphql-ws treats an exception there as a fatal bad response and tears
      // down the whole subscription for every notification type.
      for (const handler of [...set]) {
        try {
          (handler as (n: unknown) => void)(payload);
        } catch (error) {
          console.error(`[NetworkManager] ${kind} handler threw:`, error);
        }
      }
    };
    const handlers: UdpNotificationHandlers = {
      voxelUpdate: dispatch('voxelUpdate'),
      text: dispatch('text'),
      audio: dispatch('audio'),
      video: dispatch('video'),
      // The server's "this actor is gone" notice (CrowdyJS 15.5 / Buddy
      // v0.25): the World Stores lane removes the actor on it, and services
      // holding per-uuid resources (webcam textures) release them at once
      // instead of waiting out the 12 s stale reaper.
      actorLeft: dispatch('actorLeft'),
      clientEvent: dispatch('clientEvent'),
      serverEvent: dispatch('serverEvent'),
      singleActorMessage: dispatch('singleActorMessage'),
      channelMessage: dispatch('channelMessage'),
      genericError: dispatch('genericError'),
      connectionEvent: dispatch('connectionEvent'),
      error: dispatch('error'),
    };
    this.udpUnsubscribe = this.gameClient.udp.subscribe(handlers, this.route.appId);
  }

  // ---------------------------------------------------------------------------

  /** The last 100 log lines, newest last — for the HUD and for debugging. */
  readonly recentLogs: string[] = [];

  log(message: string): void {
    const line = `${new Date().toISOString().slice(11, 19)} ${message}`;
    this.recentLogs.push(line);
    if (this.recentLogs.length > 100) this.recentLogs.shift();
    this.events.emit('log', message);
    if (import.meta.env.DEV) console.debug(`[network] ${message}`);
  }

  close(): void {
    this.clearRefresh();
    this.disposeGameClient();
    this.identity.close();
  }
}

export type AnyNotification = UdpNotification;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
