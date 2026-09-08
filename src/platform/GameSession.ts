/**
 * The engine-agnostic facade scenes receive. One instance per entered app.
 *
 * It wraps the World Stores session (presence, chunks, save), chat, webcam,
 * and the player's identity as a small, stable surface. Scenes read `players()` to
 * render others and never touch the SDK; the loop calls `feedPose` / `moveTo`
 * with what the active scene reports.
 */
import { NetworkManager } from '@/platform/network/NetworkManager';
import { FLAG_STUDIO_OPEN, NEUTRAL_POSE, type Pose } from '@/platform/realtime/actorCodec';
import { chunkInput, type ChunkCoord } from '@/platform/realtime/space';
import {
  EMPTY_SAVE,
  disposeWorldSession,
  remotePlayers,
  worldSession,
  type ConstructWorldSession,
  type RemotePlayer,
  type SaveState,
} from '@/platform/realtime/WorldStores';
import { WebcamService } from '@/platform/media/WebcamService';
import { ModelService } from '@/platform/model/ModelService';
import { ChatService } from '@/platform/social/ChatService';
import { StudioService } from '@/platform/studio/StudioService';
import { Emitter } from '@/platform/util/Emitter';

export interface GameSessionEvents {
  joined: { chunk: ChunkCoord };
  left: undefined;
}

export const TINT_COUNT = 8;

export class GameSession {
  readonly events = new Emitter<GameSessionEvents>();
  readonly chat: ChatService;
  /** Proximity webcam: `toggle()` to send; scenes listen for `frame`/`ended`. */
  readonly webcam: WebcamService;
  readonly studio: StudioService;
  readonly model: ModelService;
  /** Flipped by the Studio service so other players see the "coding" marker. */
  studioOpen = false;

  private joinedFlag = false;
  private tintValue = 0;
  private save: SaveState = { ...EMPTY_SAVE };

  constructor(readonly network: NetworkManager = NetworkManager.instance) {
    this.chat = new ChatService(network);
    this.webcam = new WebcamService({
      onVideo: (handler) => network.on('video', handler),
      onActorLeft: (handler) => network.on('actorLeft', handler),
      onLaneLeave: (handler) =>
        this.world.actors.lane('players').onLeave((actor) => handler(actor.uuid)),
      selfUuid: () => (this.joinedFlag ? this.world.self.uuid : null),
      selfChunk: () => {
        if (!this.joinedFlag) return null;
        const chunk = this.world.self.chunk;
        return chunk ? { x: String(chunk.x), y: String(chunk.y), z: String(chunk.z) } : null;
      },
      appId: () => this.appId,
      sendVideoFrame: (input) => network.game.udp.sendVideoFrame(input),
      log: (message) => network.log(message),
    });
    this.studio = new StudioService(this);
    this.model = new ModelService(this);
  }

  get appId(): string {
    const appId = this.network.appId;
    if (!appId) throw new Error('GameSession needs an entered app');
    return appId;
  }

  get userId(): string {
    return this.network.user?.userId ?? '';
  }

  /** What other players see over your head. */
  get displayName(): string {
    const user = this.network.user;
    return (user?.gamertag || user?.email?.split('@')[0] || 'player').slice(0, 20);
  }

  get tint(): number {
    return this.tintValue;
  }

  setTint(tint: number): void {
    this.tintValue = ((tint % TINT_COUNT) + TINT_COUNT) % TINT_COUNT;
    this.world.save.patch({ tint: this.tintValue });
  }

  get joined(): boolean {
    return this.joinedFlag;
  }

  /** The World Stores session for this app (lazily created). */
  get world(): ConstructWorldSession {
    return worldSession();
  }

  get selfUuid(): string {
    return this.world.self.uuid;
  }

  /** The saved state as loaded (or the empty default). */
  get saved(): Readonly<SaveState> {
    return this.save;
  }

  /** Load the save blob and hydrate identity-ish fields (tint). */
  async loadSave(): Promise<SaveState> {
    const loaded = await this.world.save.load();
    this.save = loaded && loaded.version === 1 ? loaded : { ...EMPTY_SAVE };
    if (!loaded) this.world.save.set(this.save);
    if (this.save.tint !== undefined) this.tintValue = this.save.tint;
    else this.setTint(hashTint(this.userId));
    return this.save;
  }

  /** Announce presence at `position` and start receiving the world. */
  async join(position: { x: number; y: number; z: number }): Promise<void> {
    const chunk = chunkInput({
      x: Math.floor(position.x / 16),
      y: Math.floor(position.y / 16),
      z: Math.floor(position.z / 16),
    });
    await this.world.self.join(chunk, {
      ...NEUTRAL_POSE,
      x: position.x,
      y: position.y,
      z: position.z,
      name: this.displayName,
      tint: this.tint,
    });
    this.joinedFlag = true;
    this.chat.start();
    this.webcam.listen();
    this.world.save.patch({ visits: (this.save.visits ?? 0) + 1 });
    this.events.emit('joined', {
      chunk: { x: Number(chunk.x), y: Number(chunk.y), z: Number(chunk.z) },
    });
  }

  feedPose(pose: Pose): void {
    if (!this.joinedFlag) return;
    this.world.self.setState(pose);
  }

  extraPoseFlags(): number {
    return this.studioOpen ? FLAG_STUDIO_OPEN : 0;
  }

  async moveTo(chunk: ChunkCoord): Promise<void> {
    if (!this.joinedFlag) return;
    try {
      await this.world.self.moveTo(chunkInput(chunk));
      await this.world.chunks.ensureAround(chunk, 1);
    } catch (error) {
      this.network.log(`moveTo failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  rememberPosition(sceneId: string, pose: Pose): void {
    this.world.save.patch({
      position: { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw },
      lastProgram: sceneId === 'holodeck' ? 0 : this.save.lastProgram,
    });
  }

  rememberProgram(programId: number): void {
    this.save = { ...this.save, lastProgram: programId };
    this.world.save.patch({ lastProgram: programId });
  }

  /** Remote players, optionally only those in the same program. */
  players(programId?: number): RemotePlayer[] {
    const all = remotePlayers();
    return programId === undefined ? all : all.filter((p) => p.pose.program === programId);
  }

  async flushSave(): Promise<void> {
    try {
      await this.world.save.save();
    } catch (error) {
      this.network.log(`save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async leave(): Promise<void> {
    if (!this.joinedFlag) return;
    this.joinedFlag = false;
    this.chat.stop();
    this.webcam.dispose();
    this.studio.close();
    await this.flushSave();
    disposeWorldSession();
    this.events.emit('left', undefined);
  }
}

function hashTint(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % TINT_COUNT;
}
