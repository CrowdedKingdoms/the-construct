/**
 * The built hull under Afterburn's ship mesh: fuselage, nose, wings, and
 * canopy made of primitives. The Quaternius GLB stays in Crowdy-Games.
 */
import * as THREE from 'three';

export type HullId = 'arwing' | 'wolfen' | 'pod';

export const HULL_HIT_RADIUS = 1.55;

/** Alice flies the swept wing, Bob the pod, everyone else the interceptor. */
export function hullForName(name: string): HullId {
  const key = name.trim().toLowerCase();
  if (key === 'alice') return 'wolfen';
  if (key === 'bob') return 'pod';
  return 'arwing';
}

export function buildHull(id: HullId, color: number, accent: number): THREE.Group {
  if (id === 'wolfen') return wolfen(color, accent);
  if (id === 'pod') return pod(color, accent);
  return arwing(color, accent);
}

export function disposeHull(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    const material = obj.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material.dispose();
    }
  });
}

function lambert(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function arwing(color: number, accent: number): THREE.Group {
  const group = new THREE.Group();
  const body = lambert(color);
  const trim = lambert(accent);
  const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.6, 4), body);
  fuselage.rotation.x = Math.PI / 2;
  fuselage.position.z = -0.3;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 4), trim);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = -1.1;
  const wingGeo = new THREE.BoxGeometry(1.4, 0.06, 0.5);
  const wingL = new THREE.Mesh(wingGeo, trim);
  wingL.position.set(-0.75, 0, 0.1);
  wingL.rotation.z = 0.08;
  const wingR = wingL.clone();
  wingR.position.x = 0.75;
  wingR.rotation.z = -0.08;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.35), body);
  tail.position.set(0, 0.12, 0.75);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), lambert(0x88ccff));
  canopy.position.set(0, 0.14, -0.35);
  canopy.scale.set(1, 0.6, 1.2);
  group.add(fuselage, nose, wingL, wingR, tail, canopy);
  group.scale.setScalar(2.2);
  return group;
}

function wolfen(color: number, accent: number): THREE.Group {
  const group = new THREE.Group();
  const body = lambert(color);
  const trim = lambert(accent);
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.28, 1.5), body);
  fuselage.position.z = -0.2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 3), trim);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = -1.05;
  const wingGeo = new THREE.BoxGeometry(1.6, 0.05, 0.35);
  const wingL = new THREE.Mesh(wingGeo, trim);
  wingL.position.set(-0.85, 0, 0.25);
  wingL.rotation.z = 0.2;
  const wingR = wingL.clone();
  wingR.position.x = 0.85;
  wingR.rotation.z = -0.2;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.3), trim);
  fin.position.set(0, 0.28, 0.65);
  group.add(fuselage, nose, wingL, wingR, fin);
  group.scale.setScalar(2.15);
  return group;
}

function pod(color: number, accent: number): THREE.Group {
  const group = new THREE.Group();
  const body = lambert(color);
  const trim = lambert(accent);
  const hull = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), body);
  hull.scale.set(1.1, 0.85, 1.25);
  hull.position.z = -0.1;
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.06, 6, 12), trim);
  band.rotation.y = Math.PI / 2;
  band.position.z = 0.05;
  const podL = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 5), trim);
  podL.position.set(-0.55, -0.05, 0.35);
  const podR = podL.clone();
  podR.position.x = 0.55;
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.25, 6), trim);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = 0.72;
  group.add(hull, band, podL, podR, nozzle);
  group.scale.setScalar(2.05);
  return group;
}
