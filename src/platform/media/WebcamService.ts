/**
 * Proximity webcam over the realtime plane — engine-agnostic.
 *
 * Capture: `getUserMedia` at 128×96 / 10 fps → an offscreen canvas → a small
 * JPEG (≤ `MAX_FRAME_BYTES`) → `udp.sendVideoFrame`, which cuts the frame into
 * UDP-sized fragments and sends each as a `sendVideoPacket` addressed to the
 * chunk the local actor stands in. Every receiver within `distance` chunks
 * pays the bytes, so the defaults are deliberately small and the distance is
 * 1 (this chunk and its neighbours), not the pose replication distance.
 *
 * Playback: every `video` notification is one fragment. The SDK's
 * `VideoFrameAssembler` puts frames back together per sender; a completed
 * frame is decoded to an `ImageBitmap` and handed to whoever listens
 * (`frame(uuid, bitmap)`). Scenes draw it however they like — the holodeck
 * puts it on the avatar's face, the paint program only shows a "camera on"
 * ring. Listeners own the bitmap they receive and close it when they replace
 * or drop it.
 *
 * Leaving: the server's `actorLeft` notice (and, as a fallback, the World
 * Stores lane's `onLeave` reaper) ends the sender's stream at once —
 * `ended(uuid)` — so no texture outlives the player.
 *
 * Permission: `use_video_chat` on the sender's tier (and any grid limit under
 * them). Without it the API refuses `sendVideoPacket` with `UNAUTHORIZED`,
 * which this service reports once and then stops sending. The Setup wizard
 * grants the key on the Constructor tier.
 *
 * Mods do not get the camera: there is no host call for it, on purpose.
 */
import {
  VideoFrameAssembler,
  VideoCodec,
  decodeBase64,
  type AssembledVideoFrame,
} from '@crowdedkingdoms/crowdyjs';

import { Emitter } from '@/platform/util/Emitter';

export interface WebcamEvents {
  /** A complete frame from a nearby player (never the local player). */
  frame: { uuid: string; bitmap: ImageBitmap; frameId: number };
  /** The player's stream is over: they left, or their frames stopped. */
  ended: { uuid: string };
  /** Local capture state changed (for the HUD toggle and self-preview). */
  local: { live: boolean; stream: MediaStream | null; error: string | null };
}

/** Capture size and rate. Small on purpose: every receiver pays the bytes. */
export const CAPTURE_WIDTH = 128;
export const CAPTURE_HEIGHT = 96;
export const CAPTURE_FPS = 10;
/** Frames above this are re-encoded at a lower quality, then dropped. */
export const MAX_FRAME_BYTES = 8 * 1024;
/** Chunks around the sender's that receive the frames (0 = own chunk only). */
export const VIDEO_DISTANCE = 1;
/** A sender with no frame for this long is treated as ended (fallback). */
export const REMOTE_IDLE_MS = 3_000;

/**
 * What the service needs from the platform, as an interface so a unit test
 * can drive it without a network or a browser. `NetworkManager` + `GameSession`
 * satisfy it in `GameSession.webcam`.
 */
export interface WebcamTransport {
  /** Subscribe to `video` / `actorLeft` notifications; returns unsubscribe. */
  onVideo(handler: (n: { uuid: string; videoData: string }) => void): () => void;
  onActorLeft(handler: (n: { uuid: string }) => void): () => void;
  /** The World Stores reaper: fires when a stale actor is dropped. */
  onLaneLeave(handler: (uuid: string) => void): () => void;
  /** The local actor's uuid (frames from it are ignored on receive). */
  selfUuid(): string | null;
  /** Where the local actor is; null when not joined. */
  selfChunk(): { x: string; y: string; z: string } | null;
  appId(): string;
  sendVideoFrame(input: {
    appId: string;
    chunk: { x: string; y: string; z: string };
    uuid: string;
    frame: Uint8Array;
    frameId: number;
    codec: VideoCodec;
    distance: number;
  }): Promise<number>;
  log(message: string): void;
}

/** Decodes an encoded frame to a bitmap. Injected so tests need no canvas. */
export type FrameDecoder = (frame: AssembledVideoFrame) => Promise<ImageBitmap>;

export const decodeWithCreateImageBitmap: FrameDecoder = (frame) =>
  createImageBitmap(
    new Blob([frame.bytes as BlobPart], {
      type: frame.codec === VideoCodec.WEBP ? 'image/webp' : 'image/jpeg',
    }),
  );

export class WebcamService {
  readonly events = new Emitter<WebcamEvents>();

  private readonly assembler = new VideoFrameAssembler();
  private readonly remoteLastFrame = new Map<string, number>();
  private unsubscribes: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private encoding = false;
  private frameId = 0;
  /** Frames the API accepted since start(); for the HUD and the live test. */
  framesSent = 0;
  private quality = 0.6;
  private errorValue: string | null = null;
  private refusedOnce = false;

  constructor(
    private readonly transport: WebcamTransport,
    private readonly decode: FrameDecoder = decodeWithCreateImageBitmap,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------

  /** Begin receiving other players' frames. Idempotent. */
  listen(): void {
    if (this.unsubscribes.length > 0) return;
    this.unsubscribes.push(
      this.transport.onVideo((n) => void this.ingest(n.uuid, n.videoData)),
      this.transport.onActorLeft((n) => this.end(n.uuid)),
      this.transport.onLaneLeave((uuid) => this.end(uuid)),
    );
    this.idleTimer = setInterval(() => this.reapIdle(), 1_000);
  }

  /** True while frames are arriving from this player. */
  isLive(uuid: string): boolean {
    return this.remoteLastFrame.has(uuid);
  }

  /** Players currently sending video. */
  liveSenders(): string[] {
    return [...this.remoteLastFrame.keys()];
  }

  private async ingest(uuid: string, videoData: string): Promise<void> {
    if (uuid === this.transport.selfUuid()) return;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(videoData);
    } catch {
      return;
    }
    const frame = this.assembler.ingest(uuid, bytes, this.now());
    if (!frame) return;
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.decode(frame);
    } catch (error) {
      this.transport.log(
        `video frame from ${uuid.slice(0, 8)} did not decode: ${messageOf(error)}`,
      );
      return;
    }
    // The sender may have left while we decoded; do not resurrect them.
    if (!this.unsubscribes.length) {
      bitmap.close();
      return;
    }
    this.remoteLastFrame.set(uuid, this.now());
    this.events.emit('frame', { uuid, bitmap, frameId: frame.frameId });
  }

  private end(uuid: string): void {
    this.assembler.forget(uuid);
    if (!this.remoteLastFrame.delete(uuid)) return;
    this.events.emit('ended', { uuid });
  }

  private reapIdle(): void {
    const cutoff = this.now() - REMOTE_IDLE_MS;
    for (const [uuid, at] of this.remoteLastFrame) if (at < cutoff) this.end(uuid);
    this.assembler.prune(this.now());
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  get isTransmitting(): boolean {
    return this.captureTimer !== null;
  }

  /** The local camera stream while live (for a self-preview), else null. */
  get localStream(): MediaStream | null {
    return this.stream;
  }

  get error(): string | null {
    return this.errorValue;
  }

  async toggle(): Promise<void> {
    if (this.isTransmitting) this.stop();
    else await this.start();
  }

  /** Ask for the camera and start sending frames. Resolves once capturing. */
  async start(): Promise<void> {
    if (this.captureTimer) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.fail('This browser has no camera access');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, frameRate: CAPTURE_FPS },
        audio: false,
      });
    } catch (error) {
      this.fail(`Camera unavailable: ${messageOf(error)}`);
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    await video.play().catch(() => undefined);
    this.video = video;
    this.canvas =
      typeof OffscreenCanvas === 'undefined'
        ? Object.assign(document.createElement('canvas'), {
            width: CAPTURE_WIDTH,
            height: CAPTURE_HEIGHT,
          })
        : new OffscreenCanvas(CAPTURE_WIDTH, CAPTURE_HEIGHT);
    this.errorValue = null;
    this.refusedOnce = false;
    this.captureTimer = setInterval(() => void this.captureOnce(), 1000 / CAPTURE_FPS);
    this.events.emit('local', { live: true, stream: this.stream, error: null });
  }

  /** Stop sending and release the camera. Receiving continues. */
  stop(): void {
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    this.video?.pause();
    this.video = null;
    this.canvas = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const wasLive = this.stream !== null;
    this.stream = null;
    if (wasLive) this.events.emit('local', { live: false, stream: null, error: this.errorValue });
  }

  private async captureOnce(): Promise<void> {
    if (this.encoding || !this.video || !this.canvas) return;
    const chunk = this.transport.selfChunk();
    const uuid = this.transport.selfUuid();
    if (!chunk || !uuid) return;
    if (this.video.readyState < 2) return; // HAVE_CURRENT_DATA
    this.encoding = true;
    try {
      const frame = await this.encodeFrame();
      if (!frame) return;
      this.frameId = (this.frameId + 1) & 0xffff;
      await this.transport.sendVideoFrame({
        appId: this.transport.appId(),
        chunk,
        uuid,
        frame,
        frameId: this.frameId,
        codec: VideoCodec.JPEG,
        distance: VIDEO_DISTANCE,
      });
      this.framesSent += 1;
    } catch (error) {
      const message = messageOf(error);
      if (/UNAUTHORIZED|permission/i.test(message)) {
        // The tier (or a grid under us) lacks use_video_chat. Say so once and
        // stop rather than sending 10 refusals a second.
        if (!this.refusedOnce) {
          this.refusedOnce = true;
          this.fail('Camera refused: this app does not grant use_video_chat here');
          this.stop();
        }
      } else {
        this.transport.log(`video send failed: ${message}`);
      }
    } finally {
      this.encoding = false;
    }
  }

  /** Draw the current video frame and encode it as a JPEG under the size cap. */
  private async encodeFrame(): Promise<Uint8Array | null> {
    const canvas = this.canvas;
    const video = this.video;
    if (!canvas || !video) return null;
    const ctx = canvas.getContext('2d') as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
    for (let attempt = 0; attempt < 3; attempt++) {
      const blob = await toBlob(canvas, this.quality);
      if (!blob) return null;
      if (blob.size <= MAX_FRAME_BYTES) {
        // Creep the quality back up while there is headroom.
        if (blob.size < MAX_FRAME_BYTES / 2 && this.quality < 0.8) this.quality += 0.05;
        return new Uint8Array(await blob.arrayBuffer());
      }
      this.quality = Math.max(0.2, this.quality - 0.15);
    }
    return null; // still too big: skip this frame rather than send a partial one
  }

  private fail(message: string): void {
    this.errorValue = message;
    this.transport.log(message);
    this.events.emit('local', { live: false, stream: null, error: message });
  }

  /** Stop everything: capture, receiving, and every remote stream. */
  dispose(): void {
    this.stop();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const uuid of [...this.remoteLastFrame.keys()]) this.end(uuid);
  }
}

function toBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
