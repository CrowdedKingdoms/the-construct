/**
 * CLIENT scene_catalog / scene_instances. A module uploads a construct.scene.v1
 * library once, then a short list of roots. The page clones each template into
 * flat nodes for InstanceLayer. Primitive geometries stay shared there.
 * The module never receives a THREE.Mesh.
 */
import {
  MAX_ID_CHARS,
  MIN_SIZE,
  MAX_SIZE,
  clamp,
  parseSceneCatalog,
  quatMultiply,
  rotateByQuat,
  type SceneCatalog,
  type SceneMesh,
  type SceneNode,
} from './instanceSchema';
import type { ModOverlayObject } from './modOverlay';

/** One record per body. The catalog, not this list, holds the parts. */
export const MAX_SCENE_INSTANCES = 16;
/** Expanded parts across every instance. The catalog itself stays at 64 nodes. */
export const MAX_EXPANDED_NODES = 512;
const HIDE_SCALE = 0.08;

interface SceneInstance {
  id: string;
  template: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  sx: number;
  sy: number;
  sz: number;
  bindActor?: string;
}

interface SourceScene {
  catalog: SceneCatalog | null;
  instances: SceneInstance[];
}

interface FlatPart {
  node: SceneNode;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  sx: number;
  sy: number;
  sz: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function payloadOf(payload: unknown): unknown {
  const rec = asRecord(payload);
  if (rec && asRecord(rec.payload)) return rec.payload;
  return payload;
}

function finite(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function textId(value: unknown, fallback: string, max = MAX_ID_CHARS): string {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, max);
  return fallback.slice(0, max);
}

function parseInstance(row: unknown, index: number): SceneInstance | null {
  const rec = asRecord(row);
  if (!rec) return null;
  const template = textId(rec.template ?? rec.templateId, '');
  if (!template) return null;
  const bindRaw = rec.bindActor ?? rec.bind_actor ?? rec.actor;
  const bind =
    typeof bindRaw === 'string' && bindRaw.trim() ? bindRaw.trim().slice(0, 64) : undefined;
  return {
    id: textId(rec.id, `inst-${index}`, 64),
    template,
    x: finite(rec.x, 0),
    y: finite(rec.y, 0),
    z: finite(rec.z, 0),
    qx: finite(rec.qx, 0),
    qy: finite(rec.qy, 0),
    qz: finite(rec.qz, 0),
    qw: finite(rec.qw, 1),
    sx: finite(rec.sx, 1),
    sy: finite(rec.sy, 1),
    sz: finite(rec.sz, 1),
    bindActor: bind,
  };
}

/** Parts under a template root, in the root's local space. The root itself is not a part. */
function templateParts(nodes: readonly SceneNode[], templateId: string): FlatPart[] {
  const children = new Map<string, SceneNode[]>();
  for (const node of nodes) {
    if (!node.parent) continue;
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }
  const out: FlatPart[] = [];
  const walk = (
    parentId: string,
    px: number,
    py: number,
    pz: number,
    pqx: number,
    pqy: number,
    pqz: number,
    pqw: number,
    psx: number,
    psy: number,
    psz: number,
  ) => {
    for (const child of children.get(parentId) ?? []) {
      const [rx, ry, rz] = rotateByQuat(
        pqx,
        pqy,
        pqz,
        pqw,
        child.x * psx,
        child.y * psy,
        child.z * psz,
      );
      const [qx, qy, qz, qw] = quatMultiply(
        pqx,
        pqy,
        pqz,
        pqw,
        child.qx,
        child.qy,
        child.qz,
        child.qw,
      );
      const flat: FlatPart = {
        node: child,
        x: px + rx,
        y: py + ry,
        z: pz + rz,
        qx,
        qy,
        qz,
        qw,
        sx: psx * child.sx,
        sy: psy * child.sy,
        sz: psz * child.sz,
      };
      out.push(flat);
      walk(child.id, flat.x, flat.y, flat.z, qx, qy, qz, qw, flat.sx, flat.sy, flat.sz);
    }
  };
  walk(templateId, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
  if (out.length > 0) return out;
  const root = nodes.find((node) => node.id === templateId && node.visible);
  if (!root) return [];
  return [
    {
      node: root,
      x: root.x,
      y: root.y,
      z: root.z,
      qx: root.qx,
      qy: root.qy,
      qz: root.qz,
      qw: root.qw,
      sx: root.sx,
      sy: root.sy,
      sz: root.sz,
    },
  ];
}

function bake(source: string, instance: SceneInstance, part: FlatPart): ModOverlayObject {
  const lx = part.x * instance.sx;
  const ly = part.y * instance.sy;
  const lz = part.z * instance.sz;
  const [qx, qy, qz, qw] = quatMultiply(
    instance.qx,
    instance.qy,
    instance.qz,
    instance.qw,
    part.qx,
    part.qy,
    part.qz,
    part.qw,
  );
  let x = lx;
  let y = ly;
  let z = lz;
  if (!instance.bindActor) {
    const [rx, ry, rz] = rotateByQuat(instance.qx, instance.qy, instance.qz, instance.qw, lx, ly, lz);
    x = instance.x + rx;
    y = instance.y + ry;
    z = instance.z + rz;
  }
  const node: ModOverlayObject = {
    id: `${source}/${instance.id}/${part.node.id}`,
    mesh: part.node.mesh,
    kind: part.node.kind,
    shape: part.node.kind,
    x,
    y,
    z,
    qx,
    qy,
    qz,
    qw,
    sx: clamp(part.sx * instance.sx, MIN_SIZE, MAX_SIZE),
    sy: clamp(part.sy * instance.sy, MIN_SIZE, MAX_SIZE),
    sz: clamp(part.sz * instance.sz, MIN_SIZE, MAX_SIZE),
    color: part.node.color,
    visible: true,
    bindActor: instance.bindActor,
    unlit: part.node.unlit,
    shading: part.node.shading,
    flat: part.node.flat,
    opacity: part.node.opacity,
    blend: part.node.blend,
    depthWrite: part.node.depthWrite,
    emissive: part.node.emissive,
    side: part.node.side,
    fog: part.node.fog,
  };
  return node;
}

export class ModSceneStore {
  private readonly bySource = new Map<string, SourceScene>();
  private revisionValue = 0;

  get revision(): number {
    return this.revisionValue;
  }

  setCatalog(source: string, payload: unknown): { ok: boolean; revision?: number; ignored?: boolean } {
    const catalog = parseSceneCatalog(payloadOf(payload));
    if (!catalog) return { ok: false };
    const prev = this.bySource.get(source);
    if (prev?.catalog && prev.catalog.revision === catalog.revision) {
      return { ok: true, revision: catalog.revision, ignored: true };
    }
    this.bySource.set(source, { catalog, instances: prev?.instances ?? [] });
    this.revisionValue += 1;
    return { ok: true, revision: catalog.revision };
  }

  setInstances(source: string, payload: unknown): { ok: boolean; count: number } {
    const body = asRecord(payloadOf(payload));
    const list = body && Array.isArray(body.instances) ? body.instances : [];
    const instances: SceneInstance[] = [];
    for (const row of list) {
      if (instances.length >= MAX_SCENE_INSTANCES) break;
      const parsed = parseInstance(row, instances.length);
      if (parsed) instances.push(parsed);
    }
    const prev = this.bySource.get(source);
    this.bySource.set(source, { catalog: prev?.catalog ?? null, instances });
    this.revisionValue += 1;
    return { ok: true, count: instances.length };
  }

  /** Flat parts for the holodeck. A scale under 0.08 drops that whole instance. */
  expand(): ModOverlayObject[] {
    const out: ModOverlayObject[] = [];
    for (const [source, row] of this.bySource) {
      if (!row.catalog) continue;
      for (const instance of row.instances) {
        if (out.length >= MAX_EXPANDED_NODES) return out;
        const scale = Math.max(instance.sx, instance.sy, instance.sz);
        if (scale < HIDE_SCALE) continue;
        for (const part of templateParts(row.catalog.nodes, instance.template)) {
          if (!part.node.visible) continue;
          if (out.length >= MAX_EXPANDED_NODES) return out;
          out.push(bake(source, instance, part));
        }
      }
    }
    return out;
  }

  meshes(): SceneMesh[] {
    const out: SceneMesh[] = [];
    const seen = new Set<string>();
    for (const row of this.bySource.values()) {
      for (const mesh of row.catalog?.meshes ?? []) {
        if (seen.has(mesh.id)) continue;
        seen.add(mesh.id);
        out.push(mesh);
      }
    }
    return out;
  }

  /** Actors whose capsule the page should hide because a template is bound to them. */
  boundActors(): Set<string> {
    const ids = new Set<string>();
    for (const row of this.bySource.values()) {
      for (const instance of row.instances) {
        if (!instance.bindActor) continue;
        if (Math.max(instance.sx, instance.sy, instance.sz) < HIDE_SCALE) continue;
        ids.add(instance.bindActor);
      }
    }
    return ids;
  }

  remove(source: string): void {
    if (!this.bySource.delete(source)) return;
    this.revisionValue += 1;
  }

  clear(): void {
    if (this.bySource.size === 0) return;
    this.bySource.clear();
    this.revisionValue += 1;
  }
}
