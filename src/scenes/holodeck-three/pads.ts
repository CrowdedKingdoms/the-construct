/**
 * Pads: glowing discs on the holodeck floor. Stand on one and press E.
 * Program pads load a program scene; the claim pad claims the chunk you are
 * standing on and opens Crowdy Studio.
 */
import * as THREE from 'three';

import { CLAIM_PAD, PROGRAMS, type ProgramDefinition } from '@/platform/programs';
import { makeNameplate } from '@/scenes/holodeck-three/nameplate';

export type PadKind = { kind: 'program'; program: ProgramDefinition } | { kind: 'claim' };

export interface Pad {
  id: string;
  kind: PadKind;
  label: string;
  position: THREE.Vector3;
  radius: number;
  group: THREE.Group;
  ring: THREE.Mesh;
}

export const PAD_RADIUS = 1.6;

export function buildPads(scene: THREE.Scene): Pad[] {
  const pads: Pad[] = [];
  for (const program of PROGRAMS) {
    pads.push(
      makePad(scene, {
        id: `program:${program.programId}`,
        kind: { kind: 'program', program },
        label: `Load: ${program.name}`,
        x: program.pad.x,
        z: program.pad.z,
        color: program.color,
      }),
    );
  }
  pads.push(
    makePad(scene, {
      id: 'claim',
      kind: { kind: 'claim' },
      label: 'Claim & Studio',
      x: CLAIM_PAD.x,
      z: CLAIM_PAD.z,
      color: CLAIM_PAD.color,
    }),
  );
  return pads;
}

function makePad(
  scene: THREE.Scene,
  spec: { id: string; kind: PadKind; label: string; x: number; z: number; color: number },
): Pad {
  const group = new THREE.Group();
  group.position.set(spec.x, 0, spec.z);
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS, 0.08, 40),
    new THREE.MeshStandardMaterial({
      color: 0x0d1420,
      emissive: spec.color,
      emissiveIntensity: 0.18,
      roughness: 0.3,
      metalness: 0.2,
    }),
  );
  disc.position.y = 0.04;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(PAD_RADIUS, 0.06, 10, 60),
    new THREE.MeshBasicMaterial({ color: spec.color }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.09;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(PAD_RADIUS * 0.9, PAD_RADIUS * 0.9, 3.2, 32, 1, true),
    new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  beam.position.y = 1.65;
  const plate = makeNameplate(spec.label, spec.color);
  plate.position.y = 3.6;
  plate.scale.set(3, 0.75, 1);
  group.add(disc, ring, beam, plate);
  scene.add(group);
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    position: group.position.clone(),
    radius: PAD_RADIUS,
    group,
    ring,
  };
}

export function padAt(pads: Pad[], x: number, z: number): Pad | null {
  for (const pad of pads) {
    const dx = x - pad.position.x;
    const dz = z - pad.position.z;
    if (dx * dx + dz * dz <= pad.radius * pad.radius) return pad;
  }
  return null;
}

export function animatePads(pads: Pad[], active: Pad | null, nowMs: number): void {
  for (const pad of pads) {
    const pulse = 0.85 + Math.sin(nowMs / 500 + pad.position.x) * 0.15;
    pad.ring.scale.setScalar(pad === active ? 1.08 : pulse);
    (pad.ring.material as THREE.MeshBasicMaterial).opacity = pad === active ? 1 : 0.8;
  }
}

export function disposePads(scene: THREE.Scene, pads: Pad[]): void {
  for (const pad of pads) {
    scene.remove(pad.group);
    pad.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}
