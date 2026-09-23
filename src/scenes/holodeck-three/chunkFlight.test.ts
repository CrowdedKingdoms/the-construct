import { describe, expect, it } from 'vitest';

import { ChunkFlight, applyPlaneArcadeAngularDelta, inRangeChunk } from '@/scenes/holodeck-three/chunkFlight';
import * as THREE from 'three';

describe('chunk flight', () => {
  it('recognises the range deck', () => {
    expect(inRangeChunk(-8, 0, -8)).toBe(true);
    expect(inRangeChunk(0, 0, 6)).toBe(false);
  });

  it('flies forward inside the chunk and refuses to leave it', () => {
    const flight = new ChunkFlight();
    expect(flight.embark(0, 0, 6, 0, 0)).toBe(false);
    expect(flight.embark(-8, 0, -8, 0, 0)).toBe(true);
    const stepped = flight.step(1, 0, 0, 1);
    expect(stepped.z).toBeLessThan(-8);
    expect(stepped.x).toBeGreaterThanOrEqual(-16);
    expect(stepped.x).toBeLessThan(0);
    expect(stepped.z).toBeGreaterThanOrEqual(-16);
    expect(stepped.z).toBeLessThan(0);
  });

  it('banks with the same world-up yaw then local pitch as Afterburn', () => {
    const q = new THREE.Quaternion();
    applyPlaneArcadeAngularDelta(q, 0.4, 0.2);
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    expect(euler.y).toBeCloseTo(0.4, 5);
    expect(Math.abs(euler.x)).toBeGreaterThan(0.05);
  });

  it('hands the body back to the walker', () => {
    const flight = new ChunkFlight();
    flight.embark(-8, 0, -8, 0, 0);
    flight.disembark();
    expect(flight.flying).toBe(false);
    expect(flight.pose().y).toBe(0);
  });
});