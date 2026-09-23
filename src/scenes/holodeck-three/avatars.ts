/**
 * Remote players in the holodeck: a capsule per uuid, tinted by their `tint`,
 * a nameplate above, a small spinning marker when they have Crowdy Studio
 * open, and a "face" plane at eye height that shows their webcam while frames
 * arrive (`setFace` / `clearFace`, fed by `WebcamService`). Objects are pooled
 * by uuid and removed when the store reaps them or the server says they left.
 */
import * as THREE from 'three';

import {
  FLAG_STUDIO_OPEN,
  type Pose,
} from '@crowdedkingdoms/construct/platform/realtime/actorCodec';
import type { RemotePlayer } from '@crowdedkingdoms/construct/platform/realtime/WorldStores';
import { displayPose, tintColor } from '@/scenes/shared/interpolate';
import { inRangeChunk } from '@/scenes/holodeck-three/chunkFlight';
import { disposeNameplate, makeNameplate } from '@/scenes/holodeck-three/nameplate';
import { buildHull, disposeHull, hullForName, type HullId } from '@/scenes/holodeck-three/shipHull';

interface AvatarEntry {
  group: THREE.Group;
  body: THREE.Mesh;
  ship: THREE.Group | null;
  hullId: HullId | null;
  marker: THREE.Mesh;
  plate: THREE.Sprite;
  face: THREE.Mesh;
  faceTexture: THREE.Texture | null;
  faceBitmap: ImageBitmap | null;
  name: string;
  tint: number;
}

const HULL_ACCENT: Record<HullId, number> = {
  arwing: 0xffd166,
  wolfen: 0x7dfff2,
  pod: 0xff6b4a,
};

const BODY_GEOMETRY = new THREE.CapsuleGeometry(0.35, 0.9, 6, 12);
const MARKER_GEOMETRY = new THREE.OctahedronGeometry(0.18);
/** 4:3 like the 128×96 capture; sits just in front of the capsule at eye height. */
const FACE_GEOMETRY = new THREE.PlaneGeometry(0.48, 0.36);
const FACE_EYE_HEIGHT = 1.6;

export class AvatarPool {
  private readonly entries = new Map<string, AvatarEntry>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Bring the pool in line with the players list and animate each one. */
  sync(players: RemotePlayer[], nowMs: number): void {
    const seen = new Set<string>();
    for (const player of players) {
      seen.add(player.uuid);
      const pose = displayPose(player, nowMs);
      let entry = this.entries.get(player.uuid);
      if (!entry) {
        entry = this.create(pose);
        this.entries.set(player.uuid, entry);
      } else if (entry.name !== pose.name || entry.tint !== pose.tint) {
        this.restyle(entry, pose);
      }
      entry.group.position.set(pose.x, pose.y, pose.z);
      const aboard = inRangeChunk(pose.x, pose.y, pose.z);
      this.wearHull(entry, pose, aboard);
      if (!aboard) {
        entry.body.rotation.y = pose.yaw;
        // The face turns with the body so it faces where the player looks.
        entry.face.rotation.y = pose.yaw;
        entry.face.position.set(
          Math.sin(pose.yaw) * 0.37,
          FACE_EYE_HEIGHT,
          Math.cos(pose.yaw) * 0.37,
        );
      }
      entry.marker.visible = (pose.flags & FLAG_STUDIO_OPEN) !== 0;
      entry.marker.rotation.y = nowMs / 400;
      entry.marker.position.y = 2.15 + Math.sin(nowMs / 300) * 0.05;
    }
    for (const [uuid, entry] of this.entries) {
      if (seen.has(uuid)) continue;
      this.dispose(entry);
      this.entries.delete(uuid);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.dispose(entry);
    this.entries.clear();
  }

  private create(pose: Pose): AvatarEntry {
    const color = tintColor(pose.tint);
    const body = new THREE.Mesh(
      BODY_GEOMETRY,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.25,
        roughness: 0.4,
      }),
    );
    body.position.y = 0.8;
    const marker = new THREE.Mesh(
      MARKER_GEOMETRY,
      new THREE.MeshBasicMaterial({ color: 0xffd166 }),
    );
    marker.visible = false;
    const plate = makeNameplate(pose.name || 'player', color);
    plate.position.y = 1.9;
    const face = new THREE.Mesh(
      FACE_GEOMETRY,
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false }),
    );
    face.position.y = FACE_EYE_HEIGHT;
    face.visible = false;
    const group = new THREE.Group();
    group.add(body, marker, plate, face);
    this.scene.add(group);
    return {
      group,
      body,
      ship: null,
      hullId: null,
      marker,
      plate,
      face,
      faceTexture: null,
      faceBitmap: null,
      name: pose.name,
      tint: pose.tint,
    };
  }

  /**
   * Show a webcam frame on a player's face. Takes ownership of the bitmap
   * (closes the previous one). A uuid not yet in the pool is ignored; the
   * next frame after `sync` creates them will land.
   */
  setFace(uuid: string, bitmap: ImageBitmap): void {
    const entry = this.entries.get(uuid);
    if (!entry) {
      bitmap.close();
      return;
    }
    entry.faceBitmap?.close();
    entry.faceBitmap = bitmap;
    if (!entry.faceTexture) {
      // A plain Texture over the bitmap (CanvasTexture is typed for canvases);
      // each new frame swaps the image and flags the upload.
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      entry.faceTexture = texture;
      (entry.face.material as THREE.MeshBasicMaterial).map = texture;
      (entry.face.material as THREE.MeshBasicMaterial).needsUpdate = true;
    } else {
      entry.faceTexture.image = bitmap;
      entry.faceTexture.needsUpdate = true;
    }
    entry.face.visible = true;
  }

  /** The player's stream ended (they left or stopped): hide and free the face. */
  clearFace(uuid: string): void {
    const entry = this.entries.get(uuid);
    if (!entry) return;
    this.disposeFace(entry);
  }

  private disposeFace(entry: AvatarEntry): void {
    entry.face.visible = false;
    entry.faceTexture?.dispose();
    entry.faceTexture = null;
    (entry.face.material as THREE.MeshBasicMaterial).map = null;
    entry.faceBitmap?.close();
    entry.faceBitmap = null;
  }

  /** Inside the range chunk the pill becomes that pilot's built hull. */
  private wearHull(entry: AvatarEntry, pose: Pose, aboard: boolean): void {
    if (!aboard) {
      if (entry.ship) entry.ship.visible = false;
      entry.body.visible = true;
      entry.plate.position.y = 1.9;
      return;
    }
    const hullId = hullForName(pose.name);
    if (!entry.ship || entry.hullId !== hullId) {
      if (entry.ship) {
        entry.group.remove(entry.ship);
        disposeHull(entry.ship);
      }
      entry.ship = buildHull(hullId, tintColor(pose.tint), HULL_ACCENT[hullId]);
      entry.hullId = hullId;
      entry.group.add(entry.ship);
    }
    entry.body.visible = false;
    entry.face.visible = false;
    entry.ship.visible = true;
    entry.ship.rotation.order = 'YXZ';
    entry.ship.rotation.set(pose.pitch, pose.yaw, 0);
    entry.plate.position.y = 1.7;
  }

  private restyle(entry: AvatarEntry, pose: Pose): void {
    const color = tintColor(pose.tint);
    const material = entry.body.material as THREE.MeshStandardMaterial;
    material.color.setHex(color);
    material.emissive.setHex(color);
    entry.group.remove(entry.plate);
    disposeNameplate(entry.plate);
    entry.plate = makeNameplate(pose.name || 'player', color);
    entry.plate.position.y = 1.9;
    entry.group.add(entry.plate);
    entry.name = pose.name;
    entry.tint = pose.tint;
  }

  private dispose(entry: AvatarEntry): void {
    this.scene.remove(entry.group);
    this.disposeFace(entry);
    if (entry.ship) disposeHull(entry.ship);
    (entry.body.material as THREE.Material).dispose();
    (entry.marker.material as THREE.Material).dispose();
    (entry.face.material as THREE.Material).dispose();
    disposeNameplate(entry.plate);
  }
}
