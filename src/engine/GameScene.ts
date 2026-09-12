/**
 * The renderer adapter boundary.
 *
 * A scene owns a renderer (three.js, pixi.js, a 2D canvas, anything) and the
 * local player's position inside it. It does NOT own networking, identity,
 * persistence or Studio: those come in through `SceneContext` and are the same
 * object for every scene, which is what lets the holodeck (three.js) hand a
 * player to a program (pixi.js) without anyone reconnecting.
 *
 * The contract is deliberately small. If your game needs more from the
 * platform, add it to `GameSession` (engine-agnostic) rather than widening
 * this interface, and read docs/RENDERER-ADAPTER.md before you do.
 */
import type { GameSession } from '@/platform/GameSession';
import type { Pose } from '@/platform/realtime/actorCodec';
import type { Input } from '@/engine/Input';
import type { SceneRouter } from '@/engine/SceneRouter';

export interface SceneContext {
  /** The element the scene renders into. Sized by the loop on resize. */
  root: HTMLElement;
  /** Everything platform: session, remote players, chat, save, studio. */
  session: GameSession;
  /** Keyboard/pointer state with a suppression switch for overlays. */
  input: Input;
  /** Ask to load another scene (a program pad, a "return to hub" key). */
  router: SceneRouter;
  /** The DOM HUD: transient hints and toasts. Scenes draw no DOM themselves. */
  hud: SceneHud;
}

export interface SceneHud {
  /** A persistent one-line prompt ("Press E to load Paint"); null clears it. */
  setHint(text: string | null): void;
  /** A short-lived notice. */
  toast(text: string, tone?: 'info' | 'warn' | 'error'): void;
  /** Replace the F1 / ? overlay lines for this scene. */
  setHelpLines?(lines: string[]): void;
}

export interface SceneSize {
  width: number;
  height: number;
  /** Pixels reserved on the right by a docked overlay (Crowdy Studio). */
  rightInset: number;
}

export interface GameScene {
  /** Stable id used by the router and the save blob. */
  readonly id: string;
  /**
   * The `program` byte broadcast in the pose while the player is here
   * (0 = holodeck). Scenes hide actors whose `program` differs.
   */
  readonly programId: number;

  mount(context: SceneContext, size: SceneSize): Promise<void> | void;
  /** Called once per animation frame with seconds elapsed. Simulate + render. */
  update(dt: number, nowMs: number): void;
  resize(size: SceneSize): void;
  unmount(): void;

  /**
   * The local player's current pose in this scene's coordinates. The loop
   * feeds it to the replication store every frame (the store dedups sends).
   * A scene with no notion of position returns a fixed pose.
   */
  localPose(): Pose;
  /** Place the local player (spawn, restore from save, teleport). */
  setLocalPosition(position: { x: number; y: number; z: number; yaw?: number }): void;
}

/** A scene factory registered with the router; constructed on first load. */
export type SceneFactory = () => GameScene;
