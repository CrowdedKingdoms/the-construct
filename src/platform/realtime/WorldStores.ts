/**
 * The game's single World Stores session: SDK-managed state over ONE shared
 * `udpNotifications` subscription.
 *
 *  - `self`   — the local actor: stable uuid, typed pose, 5 Hz send loop with
 *               send-on-change dedup and keyframes. Scenes feed it a pose.
 *  - `actors` — everyone else, decoded once and routed into lanes. Both scenes
 *               render from `actors.lane('players')`; program-specific actors
 *               would get their own lane.
 *  - `chunks` — the voxel cache the paint program draws on and that CLIENT
 *               mods may read through the host-call router.
 *  - `errors` — server-reported send failures attributed to what we sent.
 *  - `host`   — actor heartbeats (keeps presence fresh for server-side gates
 *               such as player-compute occupancy; the elected host is
 *               informational).
 *  - `save`   — the typed per-user save blob, autosaved.
 *
 * Created lazily so it binds the ROUTED game client and the app the player
 * actually entered; disposed when the player leaves the app.
 */
import {
  createWorldSession,
  jsonCodec,
  localStorageUuidStore,
  type WorldSession,
} from '@crowdedkingdoms/crowdyjs/stores';

import { ACTOR_SYNC_INTERVAL_MS, REPLICATION_DISTANCE, STALE_ACTOR_TIMEOUT_MS } from '@/platform/config';
import { envScopedKey } from '@/platform/envScope';
import { NetworkManager } from '@/platform/network/NetworkManager';
import { NEUTRAL_POSE, poseCodec, type Pose } from '@/platform/realtime/actorCodec';

/** What survives between sessions. Deliberately small; add fields freely. */
export interface SaveState {
  version: 1;
  position?: { x: number; y: number; z: number; yaw: number };
  lastProgram?: number;
  visits: number;
  tint?: number;
}

export const EMPTY_SAVE: SaveState = { version: 1, visits: 0 };

function buildConfig() {
  return {
    self: {
      codec: poseCodec,
      initialState: NEUTRAL_POSE,
      uuidStore: localStorageUuidStore(envScopedKey('construct:actor-uuid')),
      sendIntervalMs: ACTOR_SYNC_INTERVAL_MS,
      distance: REPLICATION_DISTANCE,
    },
    actors: {
      codec: poseCodec,
      staleAfterMs: STALE_ACTOR_TIMEOUT_MS,
      historySize: 3,
      lanes: {
        players: () => true,
      },
    },
    chunks: {
      distance: REPLICATION_DISTANCE,
      // The Construct has no terrain to generate: a chunk the server has never
      // stored is simply empty. Seed it locally (no write-back) so the paint
      // program and CLIENT mods always see a dense grid.
      onMissing: () => ({ voxels: new Uint8Array(4096), writeBack: false }),
    },
    errors: true as const,
    host: {
      intervalMs: 3_000,
      myUserId: () => NetworkManager.instance.user?.userId ?? null,
    },
    save: {
      codec: jsonCodec<SaveState>(),
      autosaveMs: 10_000,
    },
  };
}

export type ConstructWorldSession = WorldSession<ReturnType<typeof buildConfig>>;

let session: ConstructWorldSession | null = null;
let sessionAppId: string | null = null;

/** The lazily created shared session for the CURRENT app. */
export function worldSession(): ConstructWorldSession {
  const network = NetworkManager.instance;
  const appId = network.appId;
  if (!appId) throw new Error('worldSession() needs an entered app');
  if (session && sessionAppId !== appId) disposeWorldSession();
  if (!session) {
    session = createWorldSession(network.game, appId, buildConfig());
    sessionAppId = appId;
    session.errors.onError((error) => {
      network.log(
        `UDP send error ${error.errorCode}${error.send ? ` (${error.send.kind})` : ''}`,
      );
    });
  }
  return session;
}

export function hasWorldSession(): boolean {
  return session !== null;
}

export function disposeWorldSession(): void {
  session?.dispose();
  session = null;
  sessionAppId = null;
}

/** Remote players as the scenes want them: pose + chunk + freshness. */
export interface RemotePlayer {
  uuid: string;
  pose: Pose;
  /** Newest-first samples for interpolation. */
  samples: Array<{ pose: Pose; epochMillis: number; receivedAt: number }>;
  chunk: { x: number; y: number; z: number };
  receivedAt: number;
}

export function remotePlayers(): RemotePlayer[] {
  if (!session) return [];
  return session.actors.lane('players').list().map((actor) => ({
    uuid: actor.uuid,
    pose: actor.state,
    samples: actor.samples.map((s) => ({
      pose: s.state,
      epochMillis: s.epochMillis,
      receivedAt: s.receivedAt,
    })),
    chunk: { x: Number(actor.chunk.x), y: Number(actor.chunk.y), z: Number(actor.chunk.z) },
    receivedAt: actor.receivedAt,
  }));
}
