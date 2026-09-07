/**
 * Remote players in the holodeck: a capsule per uuid, tinted by their `tint`,
 * a nameplate above, and a small spinning marker when they have Crowdy Studio
 * open. Objects are pooled by uuid and removed when the store reaps them.
 */
import * as THREE from 'three';

import { FLAG_STUDIO_OPEN, type Pose } from '@/platform/realtime/actorCodec';
import type { RemotePlayer } from '@/platform/realtime/WorldStores';
import { displayPose, tintColor } from '@/scenes/shared/interpolate';
import { disposeNameplate, makeNameplate } from '@/scenes/holodeck-three/nameplate';

interface AvatarEntry {
  group: THREE.Group;
  body: THREE.Mesh;
  marker: THREE.Mesh;
  plate: THREE.Sprite;
  name: string;
  tint: number;
}

const BODY_GEOMETRY = new THREE.CapsuleGeometry(0.35, 0.9, 6, 12);
const MARKER_GEOMETRY = new THREE.OctahedronGeometry(0.18);

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
      entry.body.rotation.y = pose.yaw;
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
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.4 }),
    );
    body.position.y = 0.8;
    const marker = new THREE.Mesh(
      MARKER_GEOMETRY,
      new THREE.MeshBasicMaterial({ color: 0xffd166 }),
    );
    marker.visible = false;
    const plate = makeNameplate(pose.name || 'player', color);
    plate.position.y = 1.9;
    const group = new THREE.Group();
    group.add(body, marker, plate);
    this.scene.add(group);
    return { group, body, marker, plate, name: pose.name, tint: pose.tint };
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
    (entry.body.material as THREE.Material).dispose();
    (entry.marker.material as THREE.Material).dispose();
    disposeNameplate(entry.plate);
  }
}
