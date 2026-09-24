/**
 * Render construct.scene.v1 instances in the holodeck. SERVER-replicated
 * nodes and local overlay_draw gizmos share this layer. Procedural meshes
 * become BufferGeometry, rebuilt only when the mesh identity changes.
 */
import * as THREE from 'three';

import type {
  ComposedInstance,
  MeshKind,
  SceneMesh,
} from '@crowdedkingdoms/construct/platform/studio/instanceSchema';
import type { InstanceSnapshot } from '@crowdedkingdoms/construct/platform/studio/instanceStore';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(0.5, 12, 10);
const CYLINDER = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const CAPSULE = new THREE.CapsuleGeometry(0.35, 0.9, 4, 8);
const PLANE = new THREE.PlaneGeometry(1, 1);

interface Entry {
  mesh: THREE.Mesh;
  kind: MeshKind;
  meshId?: string;
  ownedGeometry: boolean;
  materialKey: string;
}

export class InstanceLayer {
  private readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  sync(snapshot: InstanceSnapshot): void {
    const seen = new Set<string>();
    for (const instance of snapshot.instances) {
      if (!instance.visible) continue;
      seen.add(instance.id);
      let entry = this.entries.get(instance.id);
      const meshId = instance.mesh?.id;
      const materialKey = materialKeyOf(instance);
      if (!entry || entry.kind !== instance.kind || entry.meshId !== meshId || entry.materialKey !== materialKey) {
        if (entry) this.disposeEntry(instance.id, entry);
        entry = this.makeEntry(instance);
        this.group.add(entry.mesh);
        this.entries.set(instance.id, entry);
      }
      this.apply(entry, instance);
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.disposeEntry(id, entry);
    }
  }

  dispose(): void {
    for (const [id, entry] of this.entries) this.disposeEntry(id, entry);
    this.group.removeFromParent();
  }

  private makeEntry(instance: ComposedInstance): Entry {
    const built = this.geometryFor(instance);
    const shading = shadingOf(instance);
    const flat = instance.flat === true;
    const material =
      shading === 'basic'
        ? new THREE.MeshBasicMaterial({ color: instance.color, toneMapped: false })
        : shading === 'lambert'
          ? new THREE.MeshLambertMaterial({
              color: instance.color,
              flatShading: flat,
              emissive: instance.emissive ?? 0,
            })
          : new THREE.MeshStandardMaterial({
              color: instance.color,
              roughness: 0.35,
              metalness: 0.05,
              flatShading: flat,
              emissive: instance.emissive ?? 0,
            });
    const mesh = new THREE.Mesh(built.geometry, material);
    mesh.frustumCulled = false;
    return {
      mesh,
      kind: instance.kind,
      meshId: instance.mesh?.id,
      ownedGeometry: built.owned,
      materialKey: materialKeyOf(instance),
    };
  }

  private geometryFor(instance: ComposedInstance): {
    geometry: THREE.BufferGeometry;
    owned: boolean;
  } {
    if (instance.kind === 'mesh' && instance.mesh) {
      return { geometry: bufferGeometryFrom(instance.mesh), owned: true };
    }
    switch (instance.kind) {
      case 'sphere':
        return { geometry: SPHERE, owned: false };
      case 'cylinder':
        return { geometry: CYLINDER, owned: false };
      case 'capsule':
        return { geometry: CAPSULE, owned: false };
      case 'plane':
        return { geometry: PLANE, owned: false };
      default:
        return { geometry: BOX, owned: false };
    }
  }

  private apply(entry: Entry, instance: ComposedInstance): void {
    entry.mesh.position.set(instance.x, instance.y, instance.z);
    entry.mesh.quaternion.set(instance.qx, instance.qy, instance.qz, instance.qw);
    entry.mesh.scale.set(instance.sx, instance.sy, instance.sz);
    paintMaterial(entry.mesh.material as SceneMaterial, instance);
  }

  private disposeEntry(id: string, entry: Entry): void {
    this.group.remove(entry.mesh);
    (entry.mesh.material as THREE.Material).dispose();
    if (entry.ownedGeometry) entry.mesh.geometry.dispose();
    this.entries.delete(id);
  }
}

type SceneMaterial = THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;

function shadingOf(instance: ComposedInstance): 'standard' | 'lambert' | 'basic' {
  return instance.shading ?? (instance.unlit ? 'basic' : 'standard');
}

function paintMaterial(material: SceneMaterial, instance: ComposedInstance): void {
  const shading = shadingOf(instance);
  const opacity = instance.opacity ?? 1;
  const additive = instance.blend === 'additive';
  material.color.setHex(instance.color);
  material.opacity = opacity;
  material.transparent = additive || opacity < 1;
  material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.depthWrite = instance.depthWrite !== false;
  material.side = instance.side === 'double' ? THREE.DoubleSide : THREE.FrontSide;
  material.fog = instance.fog !== undefined ? instance.fog : shading !== 'basic';
  if ('emissive' in material && instance.emissive !== undefined) {
    material.emissive.setHex(instance.emissive);
  }
  material.needsUpdate = true;
}

function materialKeyOf(instance: ComposedInstance): string {
  const shading = instance.shading ?? (instance.unlit ? 'basic' : 'standard');
  return `${shading}:${instance.flat === true ? 1 : 0}`;
}

function bufferGeometryFrom(mesh: SceneMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  if (mesh.positions)
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  if (mesh.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  if (!mesh.normals) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** @deprecated OverlayLayer is InstanceLayer; kept so existing imports compile. */
export { InstanceLayer as OverlayLayer };
