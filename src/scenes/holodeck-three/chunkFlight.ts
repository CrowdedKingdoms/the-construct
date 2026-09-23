/**
 * A chunk-sized slice of Afterburn's arcade flight from Crowdy-Games `dev`
 * (`applyPlaneArcadeAngularDelta` in battleOrientation.ts): world-up yaw,
 * then local pitch, written into one quaternion. The holodeck walker still
 * owns the ground. Flight stays inside one 16-unit chunk.
 */
import * as THREE from 'three';

import { worldToChunk } from '@/platform/realtime/space';

/** The target-range deck. World x and z in [-16, 0), y in [0, 16). */
export const RANGE_CHUNK = { x: -1, y: 0, z: -1 } as const;

const CHUNK = 16;
const CRUISE = 8;
const MIN_SPEED = 3;
const MAX_Y = 12;

const axisY = new THREE.Vector3(0, 1, 0);
const axisX = new THREE.Vector3(1, 0, 0);
const qYaw = new THREE.Quaternion();
const qPitch = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const nose = new THREE.Vector3();

export interface FlightPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
}

export function inRangeChunk(x: number, y: number, z: number): boolean {
  const chunk = worldToChunk({ x, y, z });
  return chunk.x === RANGE_CHUNK.x && chunk.y === RANGE_CHUNK.y && chunk.z === RANGE_CHUNK.z;
}

/** Same step Afterburn uses: yaw about world up, pitch about local X. */
export function applyPlaneArcadeAngularDelta(
  attitude: THREE.Quaternion,
  deltaYaw: number,
  deltaPitch: number,
): void {
  if (Math.abs(deltaYaw) > 1e-8) {
    qYaw.setFromAxisAngle(axisY, deltaYaw);
    attitude.premultiply(qYaw);
  }
  if (Math.abs(deltaPitch) > 1e-8) {
    qPitch.setFromAxisAngle(axisX, deltaPitch);
    attitude.multiply(qPitch);
  }
  attitude.normalize();
}

function noseOf(attitude: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, -1).applyQuaternion(attitude);
}

export class ChunkFlight {
  flying = false;
  readonly attitude = new THREE.Quaternion();
  private x = 0;
  private y = 0;
  private z = 0;

  pose(): FlightPose {
    euler.setFromQuaternion(this.attitude, 'YXZ');
    const dir = noseOf(this.attitude, nose);
    const speed = this.flying ? CRUISE : 0;
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: euler.y,
      pitch: euler.x,
      roll: euler.z,
      vx: dir.x * speed,
      vy: dir.y * speed,
      vz: dir.z * speed,
    };
  }

  embark(x: number, y: number, z: number, yaw: number, pitch: number): boolean {
    if (this.flying || !inRangeChunk(x, y, z)) return false;
    this.flying = true;
    this.x = x;
    this.y = Math.max(1.5, y);
    this.z = z;
    euler.set(pitch, yaw, 0, 'YXZ');
    this.attitude.setFromEuler(euler);
    return true;
  }

  disembark(): void {
    this.flying = false;
    this.y = 0;
  }

  /**
   * Integrate one frame. `deltaYaw` / `deltaPitch` are radians.
   * `throttle` is -1..1 from the walk stick (S..W).
   */
  step(dt: number, deltaYaw: number, deltaPitch: number, throttle: number): FlightPose {
    if (!this.flying) return this.pose();
    applyPlaneArcadeAngularDelta(this.attitude, deltaYaw, deltaPitch);
    const dir = noseOf(this.attitude, nose);
    const speed = MIN_SPEED + (CRUISE - MIN_SPEED) * (0.5 + throttle * 0.5);
    const nextX = this.x + dir.x * speed * dt;
    const nextY = this.y + dir.y * speed * dt;
    const nextZ = this.z + dir.z * speed * dt;
    const lowX = RANGE_CHUNK.x * CHUNK;
    const lowZ = RANGE_CHUNK.z * CHUNK;
    this.x = Math.min(lowX + CHUNK - 0.4, Math.max(lowX + 0.4, nextX));
    this.z = Math.min(lowZ + CHUNK - 0.4, Math.max(lowZ + 0.4, nextZ));
    this.y = Math.min(MAX_Y, Math.max(0.4, nextY));
    return this.pose();
  }
}
