/**
 * The holodeck: a grid-lined void where players arrive, see each other (and
 * each other's webcams, on the avatar's face), chat, and step onto pads to
 * load programs or claim a chunk for Crowdy Studio. Voxel writes from Paint
 * and from CLIENT `voxel_set` show up here as cubes; SERVER-replicated
 * construct.scene.v1 instances (and local overlay_draw gizmos) are meshes
 * on top.
 *
 * This file is the three.js adapter. Everything it knows about other players
 * comes from `context.session.players()`; everything it says about the local
 * player leaves through `localPose()`. Replace it with your own 3D scene and
 * the rest of the repo does not change.
 */
import * as THREE from 'three';

import type {
  GameScene,
  SceneContext,
  SceneSize,
} from '@crowdedkingdoms/construct/engine/GameScene';
import { Controls, helpLines } from '@crowdedkingdoms/construct/engine/controls';
import { HOLODECK_SPAWN } from '@/game/programs';
import { NEUTRAL_POSE, type Pose } from '@crowdedkingdoms/construct/platform/realtime/actorCodec';
import {
  instanceStore,
  type RemotePlayer,
} from '@crowdedkingdoms/construct/platform/realtime/WorldStores';
import { toBrokerBounds } from '@crowdedkingdoms/construct/platform/studio/permissions';
import { AvatarPool } from '@/scenes/holodeck-three/avatars';
import { ClaimedChunkLayer, claimedChunksToDraw } from '@/scenes/holodeck-three/claimedChunkBox';
import { InstanceLayer } from '@/scenes/holodeck-three/instanceLayer';
import { animatePads, buildPads, disposePads, padAt, type Pad } from '@/scenes/holodeck-three/pads';
import { VoxelLayer } from '@/scenes/holodeck-three/voxels';
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
  wishOnGround,
  zoomDistance,
} from '@/scenes/shared/cameraLook';
import { displayPose, tintColor } from '@/scenes/shared/interpolate';
import { hullHitSegment, LASER_LIFE_S, LASER_SPEED, laserPoint } from '@/scenes/holodeck-three/chunkCombat';
import { ChunkFlight, inRangeChunk } from '@/scenes/holodeck-three/chunkFlight';
import { buildHull, disposeHull } from '@/scenes/holodeck-three/shipHull';

const ROOM_HALF = 60;
const EYE_HEIGHT = 1.6;
const WALK_SPEED = 6;
const RUN_SPEED = 11;

const IDLE_HINT =
  'Click the world to capture the mouse · then move to aim · left-click shoots · Esc releases · WASD moves';
const DECK_HINT = 'Range deck · F fly · left click fires the laser · WASD walk';
const FLY_HINT = 'Flying the hull · mouse aims · W/S speed · left click lasers · F near the floor to land';
const BUDDY_CONTROL = '/local-buddy';

export class HolodeckScene implements GameScene {
  readonly id = 'holodeck';
  readonly programId = 0;

  private context: SceneContext | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400);
  private avatars: AvatarPool | null = null;
  private voxels: VoxelLayer | null = null;
  private overlay: InstanceLayer | null = null;
  private claimedChunks: ClaimedChunkLayer | null = null;
  private pads: Pad[] = [];
  private localRig: THREE.Group | null = null;
  private localCapsule: THREE.Mesh | null = null;
  private localShip: THREE.Group | null = null;
  private readonly flight = new ChunkFlight();
  private flyHeld = false;
  private readonly bolts = new Map<
    number,
    { mesh: THREE.Mesh; x: number; y: number; z: number; dx: number; dy: number; dz: number; born: number }
  >();
  private nextBolt = 1;
  private readonly ejected = new Set<string>();
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
    this.voxels = new VoxelLayer(this.scene);
    this.overlay = new InstanceLayer(this.scene);
    this.claimedChunks = new ClaimedChunkLayer(this.scene);
    const tint = tintColor(context.session.tint);
    const rig = new THREE.Group();
    const capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({
        color: tint,
        emissive: tint,
        emissiveIntensity: 0.25,
      }),
    );
    const ship = buildHull('arwing', tint, 0xffd166);
    ship.visible = false;
    rig.add(capsule, ship);
    this.scene.add(rig);
    this.localRig = rig;
    this.localCapsule = capsule;
    this.localShip = ship;

    const onPointerDown = (event: PointerEvent) => {
      // The docked Studio panel used to block this, so aim died as soon as
      // the cursor left the preview. A press on the world captures the
      // mouse; Esc (exitLook) gives it back to the editor. Fullscreen
      // Studio still suppresses input and drops the lock itself.
      // Call requestPointerLock with no options: an unsupported option
      // rejects the whole lock, and a retry from the rejection is no
      // longer a user gesture so the browser ignores it.
      if (event.button !== 0 || context.input.suppressed) return;
      const element = renderer.domElement;
      if (document.pointerLockElement !== element) {
        element.requestPointerLock?.();
      }
      element.setPointerCapture?.(event.pointerId);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    this.disposables.push(() =>
      renderer.domElement.removeEventListener('pointerdown', onPointerDown),
    );
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
    this.voxels?.dispose();
    this.voxels = null;
    this.overlay?.dispose();
    this.overlay = null;
    this.claimedChunks?.dispose();
    this.claimedChunks = null;
    disposePads(this.scene, this.pads);
    this.pads = [];
    for (const bolt of this.bolts.values()) {
      this.scene.remove(bolt.mesh);
      bolt.mesh.geometry.dispose();
      (bolt.mesh.material as THREE.Material).dispose();
    }
    this.bolts.clear();
    this.flight.disembark();
    this.ejected.clear();
    if (this.localRig) {
      this.scene.remove(this.localRig);
      if (this.localCapsule) {
        this.localCapsule.geometry.dispose();
        (this.localCapsule.material as THREE.Material).dispose();
      }
      if (this.localShip) disposeHull(this.localShip);
      this.localRig = null;
      this.localCapsule = null;
      this.localShip = null;
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
    const onDeck = inRangeChunk(this.position.x, this.position.y, this.position.z);
    const flyDown = !input.suppressed && input.isDown('KeyF');
    const flyEdge = flyDown && !this.flyHeld;
    this.flyHeld = flyDown;

    // Look: pointer lock or RMB drag. Wheel zooms the follow camera.
    // In the air the quaternion step consumes the delta instead.
    if (!this.flight.flying && input.isLooking()) {
      const { dx, dy } = input.takePointerDelta();
      const next = applyLook(this.yaw, this.pitch, dx, dy, LOOK_SENSITIVITY);
      this.yaw = next.yaw;
      this.pitch = next.pitch;
    } else if (!this.flight.flying) {
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

    if (this.flight.flying) {
      const look = input.isLooking() ? input.takePointerDelta() : { dx: 0, dy: 0 };
      if (!input.isLooking()) input.takePointerDelta();
      const throttle = input.suppressed ? 0 : input.axes().y;
      const stepped = this.flight.step(
        dt,
        -look.dx * LOOK_SENSITIVITY,
        -look.dy * LOOK_SENSITIVITY,
        throttle,
      );
      this.position.set(stepped.x, stepped.y, stepped.z);
      this.yaw = stepped.yaw;
      this.pitch = stepped.pitch;
      this.velocity.set(stepped.vx, stepped.vy, stepped.vz);
      if (flyEdge && stepped.y < 2) {
        this.flight.disembark();
        this.position.y = 0;
        this.velocity.set(0, 0, 0);
      }
    } else {
      if (flyEdge && onDeck) {
        this.flight.embark(this.position.x, this.position.y, this.position.z, this.yaw, 0);
      }
      // Move relative to the camera yaw. Agent Play adds the same axes a human
      // WASD would, plus LOOK deltas (degrees converted to radians upstream).
      const agent = session.studio.locomotion.sample(nowMs);
      this.yaw += agent.yaw;
      this.pitch = Math.max(LOOK_PITCH_MIN, Math.min(LOOK_PITCH_MAX, this.pitch + agent.pitch));
      const human = input.suppressed ? { x: 0, y: 0 } : input.axes();
      const axes = { x: clampAxis(human.x + agent.x), y: clampAxis(human.y + agent.y) };
      const speed = input.isRun() ? RUN_SPEED : WALK_SPEED;
      const dir = wishOnGround(this.yaw, axes);
      const wish = new THREE.Vector3(dir.x, 0, dir.z);
      if (wish.lengthSq() > 0) wish.multiplyScalar(speed);
      this.velocity.lerp(wish, Math.min(1, dt * 12));
      this.position.addScaledVector(this.velocity, dt);
      this.position.x = clamp(this.position.x);
      this.position.z = clamp(this.position.z);
    }

    if (input.takePrimaryClick() && (this.flight.flying || onDeck)) this.fire(nowMs);
    this.drawBolts(nowMs, dt, session.players(this.programId));

    // Local avatar + camera. The pill is the holodeck body. On the range
    // deck it is the built interceptor hull.
    if (this.localRig && this.localCapsule && this.localShip) {
      const aboard = this.flight.flying || onDeck;
      this.localCapsule.visible = !aboard;
      this.localShip.visible = aboard;
      if (this.flight.flying) {
        this.localRig.position.set(this.position.x, this.position.y, this.position.z);
        this.localRig.quaternion.copy(this.flight.attitude);
      } else if (onDeck) {
        this.localRig.position.set(this.position.x, 1.15, this.position.z);
        this.localRig.rotation.set(0, this.yaw, 0);
      } else {
        this.localRig.position.set(this.position.x, 0.8, this.position.z);
        this.localRig.rotation.set(0, this.yaw, 0);
      }
    }
    const off = followCameraOffset(
      this.yaw,
      this.pitch,
      this.cameraDistance,
      HOLODECK_CAMERA_HEIGHT,
    );
    const camOffset = new THREE.Vector3(off.x, off.y, off.z);
    this.camera.position.copy(this.position).add(camOffset);
    this.camera.lookAt(
      this.position.x,
      this.flight.flying ? this.position.y : EYE_HEIGHT,
      this.position.z,
    );

    // Others (only those standing in the holodeck)
    this.avatars?.sync(session.players(this.programId), nowMs);
    this.voxels?.sync(session.world.chunks, this.position);
    if (session.joined) {
      const overlay = session.studio.overlay.snapshot();
      const grid = session.studio.grid;
      this.overlay?.sync(
        instanceStore().snapshot({
          overlay: overlay.objects,
          actors: [
            ...session.players().map((player) => ({
              uuid: player.uuid,
              x: player.pose.x,
              y: player.pose.y,
              z: player.pose.z,
              yaw: player.pose.yaw,
              pitch: player.pose.pitch,
            })),
            {
              uuid: session.selfUuid,
              x: this.position.x,
              y: this.position.y,
              z: this.position.z,
              yaw: this.yaw,
              pitch: this.pitch,
            },
          ],
          grid: grid ? toBrokerBounds(grid.bounds) : undefined,
        }),
      );
    }
    const claimed = claimedChunksToDraw(session.studio);
    this.claimedChunks?.sync(claimed);
    renderer.domElement.dataset.claimedChunks = String(claimed.length);

    // Pads
    const pad = padAt(this.pads, this.position.x, this.position.z);
    const onDeckNow = inRangeChunk(this.position.x, this.position.y, this.position.z);
    const hint = pad
      ? `Press E — ${pad.label}`
      : this.flight.flying
        ? FLY_HINT
        : onDeckNow
          ? DECK_HINT
          : IDLE_HINT;
    if (hint !== this.lastHint) {
      this.lastHint = hint;
      context.hud.setHint(hint);
    }
    this.activePad = pad;
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

  private fire(nowMs: number): void {
    const dir = new THREE.Vector3(0, 0, -1);
    if (this.flight.flying) dir.applyQuaternion(this.flight.attitude);
    else dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    dir.normalize();
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 1.6, 6),
      new THREE.MeshBasicMaterial({ color: 0x9bfff4 }),
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const originY = this.flight.flying ? this.position.y : 1.15;
    const origin = {
      x: this.position.x + dir.x * 1.8,
      y: originY + dir.y * 1.8,
      z: this.position.z + dir.z * 1.8,
    };
    mesh.position.set(origin.x, origin.y, origin.z);
    this.scene.add(mesh);
    this.bolts.set(this.nextBolt++, {
      mesh,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      born: nowMs,
    });
  }

  private drawBolts(nowMs: number, dt: number, players: RemotePlayer[]): void {
    for (const player of players) {
      const pose = displayPose(player, nowMs);
      if (!inRangeChunk(pose.x, pose.y, pose.z)) this.ejected.delete(player.uuid);
    }
    for (const [id, bolt] of this.bolts) {
      const age = (nowMs - bolt.born) / 1000;
      if (age > LASER_LIFE_S) {
        this.removeBolt(id, bolt);
        continue;
      }
      const origin = { x: bolt.x, y: bolt.y, z: bolt.z };
      const direction = { x: bolt.dx, y: bolt.dy, z: bolt.dz };
      const from = laserPoint(origin, direction, Math.max(0, age - dt));
      const point = laserPoint(origin, direction, age);
      bolt.mesh.position.set(point.x, point.y, point.z);
      for (const player of players) {
        if (this.ejected.has(player.uuid)) continue;
        const pose = displayPose(player, nowMs);
        if (!inRangeChunk(pose.x, pose.y, pose.z)) continue;
        if (!hullHitSegment(from, point, pose)) continue;
        this.ejectPilot(player.uuid);
        this.removeBolt(id, bolt);
        break;
      }
    }
  }

  private removeBolt(
    id: number,
    bolt: { mesh: THREE.Mesh },
  ): void {
    this.scene.remove(bolt.mesh);
    bolt.mesh.geometry.dispose();
    (bolt.mesh.material as THREE.Material).dispose();
    this.bolts.delete(id);
  }

  /** Ask the local Buddy stand-in to fly this pilot out of the range chunk. */
  private ejectPilot(uuid: string): void {
    if (this.ejected.has(uuid)) return;
    this.ejected.add(uuid);
    void fetch(`${BUDDY_CONTROL}/players/${encodeURIComponent(uuid)}/eject`, { method: 'POST' })
      .then((response) => {
        if (!response.ok) this.ejected.delete(uuid);
      })
      .catch(() => {
        this.ejected.delete(uuid);
      });
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
