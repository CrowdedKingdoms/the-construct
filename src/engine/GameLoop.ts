/**
 * The frame loop, and the one place where "the scene's local pose" becomes
 * "what everyone else sees". Each frame:
 *
 *   1. the active scene updates and renders,
 *   2. the loop reads `scene.localPose()`, stamps program/name/tint, and hands
 *      it to the replication store (which sends at 5 Hz, only on change),
 *   3. if the player crossed into another chunk, the store is told to move,
 *   4. the save blob's position is patched (autosaved by the store).
 *
 * Scenes never talk to the network for presence. That is the whole point.
 */
import type { SceneSize } from '@/engine/GameScene';
import type { SceneRouter } from '@/engine/SceneRouter';
import type { GameSession } from '@/platform/GameSession';
import { FLAG_IN_PROGRAM, FLAG_MOVING } from '@/platform/realtime/actorCodec';
import { chunkKey, worldToChunk } from '@/platform/realtime/space';

export class GameLoop {
  private frame: number | null = null;
  private lastMs = 0;
  private lastChunkKey: string | null = null;
  private lastSavePatchMs = 0;
  private rightInset = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly router: SceneRouter,
    private readonly session: GameSession,
  ) {}

  start(): void {
    if (this.frame !== null) return;
    this.resizeObserver = new ResizeObserver(() => this.router.resize(this.size()));
    this.resizeObserver.observe(this.root);
    this.router.resize(this.size());
    this.lastMs = performance.now();
    const tick = (nowMs: number) => {
      this.frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, Math.max(0, (nowMs - this.lastMs) / 1000));
      this.lastMs = nowMs;
      this.step(dt, nowMs);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** A docked overlay took `px` pixels on the right; re-measure. */
  setRightInset(px: number): void {
    this.rightInset = px;
    this.router.resize(this.size());
  }

  size(): SceneSize {
    // The stylesheet already shrinks #game-root by --ck-game-right-inset while
    // Crowdy Studio is docked, so the rect is the visible area; the inset is
    // passed along for scenes that want to know, not subtracted again.
    const rect = this.root.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
      rightInset: this.rightInset,
    };
  }

  private step(dt: number, nowMs: number): void {
    const scene = this.router.current;
    if (!scene) return;
    scene.update(dt, nowMs);
    if (!this.session.joined) return;

    const pose = scene.localPose();
    const moving = Math.hypot(pose.vx, pose.vy, pose.vz) > 0.05;
    const flags =
      (pose.flags & ~(FLAG_MOVING | FLAG_IN_PROGRAM)) |
      (moving ? FLAG_MOVING : 0) |
      (scene.programId !== 0 ? FLAG_IN_PROGRAM : 0) |
      this.session.extraPoseFlags();
    this.session.feedPose({
      ...pose,
      flags,
      program: scene.programId,
      name: this.session.displayName,
      tint: this.session.tint,
    });

    const chunk = worldToChunk(pose);
    const key = chunkKey(chunk);
    if (key !== this.lastChunkKey) {
      this.lastChunkKey = key;
      void this.session.moveTo(chunk);
    }

    if (nowMs - this.lastSavePatchMs > 2000) {
      this.lastSavePatchMs = nowMs;
      this.session.rememberPosition(scene.id, pose);
    }
  }
}
