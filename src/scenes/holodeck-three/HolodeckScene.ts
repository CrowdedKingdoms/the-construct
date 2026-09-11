/**
 * The holodeck: a grid-lined void where players arrive, see each other (and
 * each other's webcams, on the avatar's face), chat, and step onto pads to
 * load programs or claim a chunk for Crowdy Studio.
 *
 * This file is the three.js adapter. Everything it knows about other players
 * comes from `context.session.players()`; everything it says about the local
 * player leaves through `localPose()`. Replace it with your own 3D scene and
 * the rest of the repo does not change.
 */
import * as THREE from 'three';

import type { GameScene, SceneContext, SceneSize } from '@/engine/GameScene';
import { Controls, helpLines } from '@/engine/controls';
import { HOLODECK_SPAWN } from '@/platform/programs';
import { NEUTRAL_POSE, type Pose } from '@/platform/realtime/actorCodec';
import { AvatarPool } from '@/scenes/holodeck-three/avatars';
import { animatePads, buildPads, disposePads, padAt, type Pad } from '@/scenes/holodeck-three/pads';
import {
  DEFAULT_CAMERA_DISTANCE,
  HOLODECK_CAMERA_HEIGHT,
  HOLODECK_ZOOM_MAX,
  HOLODECK_ZOOM_MIN,
  LOOK_PITCH_MAX,
  LOOK_PITCH_MIN,
  LOOK_SENSITIVITY,
  applyLook,
  followCameraOffset,
  zoomDistance,
} from '@/scenes/shared/cameraLook';
import { tintColor } from '@/scenes/shared/interpolate';

const ROOM_HALF = 60;
const EYE_HEIGHT = 1.6;
const WALK_SPEED = 6;
const RUN_SPEED = 11;

const IDLE_HINT = 'WASD move · click or hold RMB to look · scroll zoom · E on a pad · F1 help';

export class HolodeckScene implements GameScene {
  readonly id = 'holodeck';
  readonly programId = 0;

  private context: SceneContext | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400);
  private avatars: AvatarPool | null = null;
  private pads: Pad[] = [];
  private localBody: THREE.Mesh | null = null;
  private disposables: Array<() => void> = [];

  private readonly position = new THREE.Vector3(HOLODECK_SPAWN.x, 0, HOLODECK_SPAWN.z);
  private readonly velocity = new THREE.Vector3();
  private yaw = HOLODECK_SPAWN.yaw;
  private pitch = -0.25;
  private cameraDistance = DEFAULT_CAMERA_DISTANCE;
  private activePad: Pad | null = null;
  private lastHint: string | null = null;

  mount(context: SceneContext, size: SceneSize): void {
    this.context = context;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size.width, size.height);
    renderer.domElement.className = 'scene-canvas';
    renderer.domElement.tabIndex = 0;
    context.root.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.buildRoom();
    this.pads = buildPads(this.scene);
    this.avatars = new AvatarPool(this.scene);
    this.localBody = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({
        color: tintColor(context.session.tint),
        emissive: tintColor(context.session.tint),
        emissiveIntensity: 0.25,
      }),
    );
    this.localBody.position.y = 0.8;
    this.scene.add(this.localBody);

    const onClick = () => {
      if (!context.input.suppressed && document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock?.();
      }
    };
    renderer.domElement.addEventListener('click', onClick);
    this.disposables.push(() => renderer.domElement.removeEventListener('click', onClick));
    this.disposables.push(context.input.onKeys(Controls.activate, () => this.activate()));
    // Webcam frames land on the avatar's face; the server's actor-left notice
    // (or the idle fallback) clears it. Players in another program are not in
    // this pool, so their frames are closed unseen.
    this.disposables.push(
      context.session.webcam.events.on('frame', ({ uuid, bitmap }) => {
        if (this.avatars) this.avatars.setFace(uuid, bitmap);
        else bitmap.close();
      }),
    );
    this.disposables.push(
      context.session.webcam.events.on('ended', ({ uuid }) => this.avatars?.clearFace(uuid)),
    );

    this.resize(size);
    context.hud.setHelpLines?.(helpLines('holodeck'));
    context.hud.setHint(IDLE_HINT);
  }

  unmount(): void {
    const context = this.context;
    for (const dispose of this.disposables) dispose();
    this.disposables = [];
    this.avatars?.clear();
    this.avatars = null;
    disposePads(this.scene, this.pads);
    this.pads = [];
    if (this.localBody) {
      this.scene.remove(this.localBody);
      this.localBody.geometry.dispose();
      (this.localBody.material as THREE.Material).dispose();
      this.localBody = null;
    }
    this.scene.clear();
    if (this.renderer) {
      if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    context?.hud.setHint(null);
    this.context = null;
  }

  resize(size: SceneSize): void {
    if (!this.renderer) return;
    this.renderer.setSize(size.width, size.height);
    this.camera.aspect = size.width / size.height;
    this.camera.updateProjectionMatrix();
  }

  setLocalPosition(position: { x: number; y: number; z: number; yaw?: number }): void {
    this.position.set(clamp(position.x), 0, clamp(position.z));
    if (position.yaw !== undefined) this.yaw = position.yaw;
    this.velocity.set(0, 0, 0);
  }

  /** Test/debug snapshot of look + zoom. */
  lookDebug(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.yaw, pitch: this.pitch, distance: this.cameraDistance };
  }

  localPose(): Pose {
    return {
      ...NEUTRAL_POSE,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      pitch: this.pitch,
      vx: this.velocity.x,
      vy: this.velocity.y,
      vz: this.velocity.z,
    };
  }

  update(dt: number, nowMs: number): void {
    const context = this.context;
    const renderer = this.renderer;
    if (!context || !renderer) return;
    const { input, session } = context;

    // Look: pointer lock or RMB drag. Wheel zooms the follow camera.
    if (input.isLooking()) {
      const { dx, dy } = input.takePointerDelta();
      const next = applyLook(this.yaw, this.pitch, dx, dy, LOOK_SENSITIVITY);
      this.yaw = next.yaw;
      this.pitch = next.pitch;
    } else {
      input.takePointerDelta();
    }
    const wheel = input.takeWheel();
    if (wheel !== 0) {
      this.cameraDistance = zoomDistance(
        this.cameraDistance,
        wheel,
        HOLODECK_ZOOM_MIN,
        HOLODECK_ZOOM_MAX,
      );
    }

    // Move relative to the camera yaw. Agent Play adds the same axes a human
    // WASD would, plus LOOK deltas (degrees converted to radians upstream).
    const agent = session.studio.locomotion.sample(nowMs);
    this.yaw += agent.yaw;
    this.pitch = Math.max(LOOK_PITCH_MIN, Math.min(LOOK_PITCH_MAX, this.pitch + agent.pitch));
    const human = input.suppressed ? { x: 0, y: 0 } : input.axes();
    const axes = { x: clampAxis(human.x + agent.x), y: clampAxis(human.y + agent.y) };
    const speed = input.isRun() ? RUN_SPEED : WALK_SPEED;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const wish = new THREE.Vector3()
      .addScaledVector(forward, axes.y)
      .addScaledVector(right, axes.x);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    this.velocity.lerp(wish, Math.min(1, dt * 12));
    this.position.addScaledVector(this.velocity, dt);
    this.position.x = clamp(this.position.x);
    this.position.z = clamp(this.position.z);

    // Local avatar + camera
    if (this.localBody) {
      this.localBody.position.set(this.position.x, 0.8, this.position.z);
      this.localBody.rotation.y = this.yaw;
    }
    const off = followCameraOffset(
      this.yaw,
      this.pitch,
      this.cameraDistance,
      HOLODECK_CAMERA_HEIGHT,
    );
    const camOffset = new THREE.Vector3(off.x, off.y, off.z);
    this.camera.position.copy(this.position).add(camOffset);
    this.camera.lookAt(this.position.x, EYE_HEIGHT, this.position.z);

    // Others (only those standing in the holodeck)
    this.avatars?.sync(session.players(this.programId), nowMs);

    // Pads
    const pad = padAt(this.pads, this.position.x, this.position.z);
    if (pad !== this.activePad) {
      this.activePad = pad;
      const hint = pad ? `Press E — ${pad.label}` : IDLE_HINT;
      if (hint !== this.lastHint) {
        this.lastHint = hint;
        context.hud.setHint(hint);
      }
    }
    animatePads(this.pads, this.activePad, nowMs);

    renderer.render(this.scene, this.camera);
  }

  private activate(): void {
    const context = this.context;
    const pad = this.activePad;
    if (!context || !pad || context.input.suppressed) return;
    if (pad.kind.kind === 'program') {
      const program = pad.kind.program;
      context.hud.toast(`Loading ${program.name}…`);
      context.session.rememberProgram(program.programId);
      void context.router.load(program.sceneId).catch((error) => {
        context.hud.toast(`Could not load ${program.name}: ${messageOf(error)}`, 'error');
      });
      return;
    }
    if (pad.kind.kind === 'claim') {
      void context.session.studio.claimHereAndOpen(this.position).catch((error) => {
        context.hud.toast(messageOf(error), 'error');
      });
    }
  }

  private buildRoom(): void {
    this.scene.background = new THREE.Color(0x07090d);
    this.scene.fog = new THREE.FogExp2(0x07090d, 0.012);

    this.scene.add(new THREE.HemisphereLight(0x8fd6c4, 0x101418, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(20, 40, 10);
    this.scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      new THREE.MeshStandardMaterial({ color: 0x0a0f16, roughness: 0.9, metalness: 0.1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(ROOM_HALF * 2, ROOM_HALF * 2, 0x2fd7ad, 0x123a36);
    grid.position.y = 0.01;
    this.scene.add(grid);

    // Walls and ceiling: the same grid, stood up, in the warmer holodeck tone.
    const wallColor = 0x6b5a2a;
    const wallCenter = 0x3a3218;
    const height = 16;
    for (const [rx, rz, x, z] of [
      [Math.PI / 2, 0, 0, -ROOM_HALF],
      [Math.PI / 2, 0, 0, ROOM_HALF],
      [Math.PI / 2, Math.PI / 2, -ROOM_HALF, 0],
      [Math.PI / 2, Math.PI / 2, ROOM_HALF, 0],
    ] as const) {
      const wall = new THREE.GridHelper(ROOM_HALF * 2, ROOM_HALF * 2, wallColor, wallCenter);
      wall.scale.z = height / (ROOM_HALF * 2);
      wall.rotation.set(rx, 0, rz);
      wall.position.set(x, height / 2, z);
      this.scene.add(wall);
    }
    const ceiling = new THREE.GridHelper(ROOM_HALF * 2, ROOM_HALF, wallColor, wallCenter);
    ceiling.position.y = height;
    this.scene.add(ceiling);
  }
}

function clamp(value: number): number {
  return Math.max(-ROOM_HALF + 1, Math.min(ROOM_HALF - 1, value));
}

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
