/**
 * The one place this game talks to Crowded Kingdoms.
 *
 * ONE token, held by two clients, one sign-in that never touches this page:
 *
 *  - the **platform** client dials the public API origin. It sends the player
 *    to Crowded Kingdoms' HOSTED sign-in (Studio's /authorize, PKCE) and
 *    receives back a short-lived **app-scoped** token for THIS app. It never
 *    sees a password, and it never holds an identity session: a browser game on
 *    its own domain cannot (the direct sign-in mutations answer
 *    HOSTED_SIGN_IN_REQUIRED from any non-first-party origin, ck-api v1.88.0).
 *  - the **game** client holds that same app token and is pointed at the app's
 *    own datacenter (the token response carries the endpoint). Everything
 *    realtime, model, Studio and persistence runs on it.
 *
 * Because the page never holds a session, everything that needs one -- creating
 * the org and the app, seeding the model, registering this origin as a redirect
 * URI -- happens in `npm run setup` (a Node script, no Origin header) or in
 * Studio. The browser knows its app id from `VITE_APP_ID`, `?app=`, or storage.
 *
 * Scenes and services never import the SDK client directly; they read
 * `NetworkManager.instance.game`. That keeps "which token, which endpoint" a
 * single decision made here.
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
import { envScopedKey, readScoped, writeScoped } from '@/platform/envScope';
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

/** Where the entered app's route is remembered across a reload (env-scoped). */
export const APP_ROUTE_STORAGE_KEY = 'construct:app-route';

/** The token store key for the app token (env-scoped). One app at a time. */
const APP_TOKEN_STORE_KEY = 'construct:app-token';

export interface BootstrapInfo {
  minimumClientVersion?: string;
  maxReplicationDistance?: number;
  udpConnected?: boolean;
  binaryRelayEnabled?: boolean;
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

  /**
   * The client on the public API origin. Holds the app token the hosted
   * sign-in returned (or nothing). Not an identity session; see the header.
   */
  readonly platform: CrowdyClient;

  private gameClient: CrowdyClient | null = null;
  private route: AppRoute | null = null;
  private userValue: SessionUser | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshFailures = 0;
  private udpUnsubscribe: UnsubscribeFn | null = null;
  private realtimeUnsubscribe: UnsubscribeFn | null = null;
  private readonly udpHandlers = new Map<UdpHandlerKind, Set<UdpHandler>>();

  private constructor() {
    this.platform = createCrowdyClient({
      httpUrl: API_HTTP_URL,
      wsUrl: API_WS_URL,
      tokenStore: new BrowserLocalStorageTokenStore(envScopedKey(APP_TOKEN_STORE_KEY)),
    });
  }

  // ---------------------------------------------------------------------------
  // Sign-in (hosted) and the player's identity
  // ---------------------------------------------------------------------------

  get user(): SessionUser | null {
    return this.userValue;
  }

  /** Holding an app token (possibly expired; `restore` finds out). */
  get isSignedIn(): boolean {
    return Boolean(this.platform.session.getToken());
  }

  /**
   * Send the player to Crowded Kingdoms' hosted sign-in for `appId`. The page
   * navigates away; on return, `completeHostedSignInIfPresent()` finishes the
   * job. The return address is this page itself, so no extra route is needed
   * on whatever static host serves the game -- but its ORIGIN must be one of
   * the app's registered redirect URIs (`npm run setup` registers the dev
   * server's; Studio > Apps > Settings adds the production one).
   */
  async signInHosted(appId: string): Promise<void> {
    if (typeof window === 'undefined') throw new Error('Hosted sign-in needs a browser');
    this.log(`Redirecting to hosted sign-in for app ${appId}`);
    await this.platform.portal.signIn({
      appId,
      redirectUri: window.location.origin + window.location.pathname,
    });
  }

  /**
   * Finish a hosted sign-in if the URL carries its `?code=`. Returns the
   * entered app's route, or null when there is nothing to finish. The SDK
   * strips `code`/`state` from the address bar so a reload does not replay.
   * An `?error=access_denied` (the player pressed Cancel on the consent
   * screen) is reported and cleared.
   */
  async completeHostedSignInIfPresent(): Promise<AppRoute | null> {
    if (typeof window === 'undefined') return null;
    const url = new URL(window.location.href);
    const denied = url.searchParams.get('error');
    if (denied) {
      url.searchParams.delete('error');
      url.searchParams.delete('state');
      window.history.replaceState({}, '', url.toString());
      this.log(`Hosted sign-in did not complete: ${denied}`);
      return null;
    }
    if (!url.searchParams.has('code')) return null;
    try {
      const minted = await this.platform.portal.handleSignInCallback();
      if (!minted) return null;
      const route = this.routeFrom(minted, minted.appId);
      writeScoped(APP_ROUTE_STORAGE_KEY, JSON.stringify(route));
      await this.hydrateUser();
      this.log(`Hosted sign-in complete for app ${route.appId}`);
      return route;
    } catch (error) {
      this.log(`Hosted sign-in failed: ${messageOf(error)}`);
      return null;
    }
  }

  /**
   * Restore a stored app token + route from a previous visit. Returns the route
   * when the token still authenticates, else null (and forgets both).
   */
  async restore(): Promise<AppRoute | null> {
    await this.platform.session.restore();
    if (!this.platform.session.getToken()) return null;
    const raw = readScoped(APP_ROUTE_STORAGE_KEY);
    let route: AppRoute | null;
    try {
      route = raw ? (JSON.parse(raw) as AppRoute) : null;
    } catch {
      route = null;
    }
    if (!route?.appId) {
      this.forgetCredentials();
      return null;
    }
    const user = await this.hydrateUser();
    if (!user) return null;
    return route;
  }

  async signOut(): Promise<void> {
    this.leaveApp();
    try {
      // An app token may end its own session.
      await this.platform.auth.logout();
    } catch {
      // Already invalid; forgetting it locally is the whole point.
    }
    this.forgetCredentials();
    this.userValue = null;
    this.events.emit('auth', null);
  }

  private forgetCredentials(): void {
    this.platform.session.setToken(null);
    writeScoped(APP_ROUTE_STORAGE_KEY, null);
  }

  private async hydrateUser(): Promise<SessionUser | null> {
    try {
      // `me` is one of the few management reads an app token may make.
      const me = await this.platform.users.me();
      if (!me) throw new Error('me() returned null');
      this.userValue = {
        userId: String(me.userId),
        email: me.email ?? undefined,
        gamertag: me.gamertag ?? undefined,
      };
      this.events.emit('auth', this.userValue);
      return this.userValue;
    } catch (error) {
      this.log(`Stored token is not valid: ${messageOf(error)}`);
      this.forgetCredentials();
      this.userValue = null;
      this.events.emit('auth', null);
      return null;
    }
  }

  private routeFrom(
    minted: {
      appId?: string | null;
      gameApiUrl?: string | null;
      gameApiWsUrl?: string | null;
      discoveryUrl?: string | null;
      expiresAt: string;
    },
    fallbackAppId: string,
  ): AppRoute {
    return {
      appId: String(minted.appId ?? fallbackAppId),
      gameApiUrl: minted.gameApiUrl ?? null,
      gameApiWsUrl: minted.gameApiWsUrl ?? null,
      discoveryUrl: minted.discoveryUrl ?? null,
      expiresAt: minted.expiresAt,
    };
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
   * Build the game client on the app's own endpoint with the app token the
   * platform client holds. Idempotent for the same app; switches cleanly for
   * another. The route comes from the hosted sign-in (or storage): the token
   * response names the datacenter endpoint and the discovery URL.
   */
  async enterApp(route: AppRoute): Promise<AppRoute> {
    const token = this.platform.session.getToken();
    if (!token) throw new Error('Sign in before entering an app');
    if (this.route && this.route.appId !== route.appId) this.leaveApp();

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
          // Live video/voice should ride the binary relay when the API
          // exposes it; CrowdyJS falls back to GraphQL if it is down.
          binaryTransport: true,
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
    this.gameClient.setToken(token);
    this.route = route;
    writeScoped(APP_ROUTE_STORAGE_KEY, JSON.stringify(route));
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
    // Present on ck-api since the binary relay shipped; the 15.11 pin's
    // generated type does not yet name the field.
    const binaryRelayEnabled =
      (boot as { binaryRelayEnabled?: boolean }).binaryRelayEnabled ?? false;
    this.log(`bootstrap: binaryRelayEnabled=${String(binaryRelayEnabled)}`);
    return {
      minimumClientVersion: min ? `${min.major}.${min.minor}.${min.patch}.${min.build}` : undefined,
      maxReplicationDistance: boot.maxReplicationDistance ?? undefined,
      udpConnected: boot.udpProxyConnectionStatus?.connected ?? undefined,
      binaryRelayEnabled,
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
   * old-token UDP proxy, refreshes, and reconnects with handlers intact. The
   * rotated token is mirrored onto the platform client so a reload restores
   * the fresh one. There is no session to re-mint from: after two failures the
   * player is sent back through hosted sign-in, which is one silent bounce
   * while their Studio session lasts.
   */
  private async rotateAppToken(): Promise<void> {
    if (!this.gameClient || !this.route) return;
    try {
      const refreshed = await this.gameClient.refreshGameplayToken();
      this.platform.session.setToken(refreshed.token);
      this.route = { ...this.route, expiresAt: refreshed.expiresAt };
      writeScoped(APP_ROUTE_STORAGE_KEY, JSON.stringify(this.route));
      this.refreshFailures = 0;
      this.log('App token rotated');
      this.scheduleRefresh(APP_TOKEN_REFRESH_MS);
    } catch (error) {
      this.refreshFailures += 1;
      this.log(`App token rotation failed (${this.refreshFailures}): ${messageOf(error)}`);
      if (this.refreshFailures >= 2) {
        const appId = this.route.appId;
        this.forgetCredentials();
        this.events.emit('auth', null);
        void this.signInHosted(appId);
        return;
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
    this.platform.close();
  }
}

export type AnyNotification = UdpNotification;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
