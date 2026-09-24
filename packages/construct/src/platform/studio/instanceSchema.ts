/**
 * construct.scene.v1 — the LCD scene graph a claimed-grid mod may put in the
 * world. SERVER owns the catalog + poses (replicated). CLIENT overlay_draw
 * uses the same JSON for local gizmos. Unknown keys are ignored.
 */
import type { PlayerCodeGridBounds } from '@crowdedkingdoms/crowdyjs';

import { CHUNK_SIZE } from '../config';

export const SCENE_VERSION = 1;
export const MAX_MESHES = 16;
export const MAX_NODES = 64;
export const MAX_OVERLAY_OBJECTS = MAX_NODES;
export const MAX_VERTS = 256;
export const MAX_INDICES = 768;
export const MAX_CATALOG_BYTES = 48 * 1024;
export const MIN_SIZE = 0.04;
export const MAX_SIZE = 8;
export const MAX_ID_CHARS = 32;

/** Construct-owned EventRouter types. Payload is the state AFTER uint16 eventType. */
export const EVENT_CATALOG = 0xc501;
export const EVENT_POSES = 0xc502;

/** emit_spatial payload is 1024 bytes including the 2-byte eventType. */
export const MAX_EVENT_STATE_BYTES = 1022;
const CATALOG_CHUNK_HEADER = 8;

export type MeshKind = 'box' | 'sphere' | 'cylinder' | 'capsule' | 'plane' | 'mesh';
export type ModOverlayShape = MeshKind;

export interface SceneMesh {
  id: string;
  kind: MeshKind;
  color: number;
  positions?: Float32Array;
  indices?: Uint16Array;
  normals?: Float32Array;
}

export interface SceneNode {
  id: string;
  parent?: string;
  mesh?: string;
  kind: MeshKind;
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
  color: number;
  visible: boolean;
  bindActor?: string;
}

/** Overlay objects are scene nodes; `shape` is an alias of `kind` for older payloads. */
export type ModOverlayObject = SceneNode & { shape: MeshKind };

export interface SceneCatalog {
  revision: number;
  meshes: SceneMesh[];
  nodes: SceneNode[];
}

export interface ActorXform {
  uuid: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface ComposedInstance {
  id: string;
  kind: MeshKind;
  mesh?: SceneMesh;
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
  color: number;
  visible: boolean;
}

export interface WorldAabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function gridWorldBounds(grid: PlayerCodeGridBounds): WorldAabb {
  return {
    minX: Number(grid.low.x) * CHUNK_SIZE,
    maxX: (Number(grid.high.x) + 1) * CHUNK_SIZE,
    minY: Number(grid.low.y) * CHUNK_SIZE,
    maxY: (Number(grid.high.y) + 1) * CHUNK_SIZE,
    minZ: Number(grid.low.z) * CHUNK_SIZE,
    maxZ: (Number(grid.high.z) + 1) * CHUNK_SIZE,
  };
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, fallback?: number): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback === undefined ? null : fallback;
}

export function parseColor(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(0xffffff, Math.floor(value)));
  }
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return Number.parseInt(hex, 16);
  }
  return 0xf8fafc;
}

function parseKind(value: unknown): MeshKind {
  if (
    value === 'sphere' ||
    value === 'cylinder' ||
    value === 'capsule' ||
    value === 'plane' ||
    value === 'mesh'
  ) {
    return value;
  }
  return 'box';
}

function parseId(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_ID_CHARS);
  return fallback.slice(0, MAX_ID_CHARS);
}

function parseQuat(rec: Record<string, unknown>): [number, number, number, number] {
  const q = asRecord(rec.q) ?? asRecord(rec.quat) ?? asRecord(rec.quaternion);
  const qx = finiteNumber(rec.qx ?? rec.qi ?? q?.x ?? q?.qx, 0) ?? 0;
  const qy = finiteNumber(rec.qy ?? rec.qj ?? q?.y ?? q?.qy, 0) ?? 0;
  const qz = finiteNumber(rec.qz ?? rec.qk ?? q?.z ?? q?.qz, 0) ?? 0;
  const qw = finiteNumber(rec.qw ?? rec.qr ?? q?.w ?? q?.qw, 1) ?? 1;
  return normalizeQuat(qx, qy, qz, qw);
}

export function normalizeQuat(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [number, number, number, number] {
  const len = Math.hypot(qx, qy, qz, qw);
  if (!Number.isFinite(len) || len < 1e-8) return [0, 0, 0, 1];
  return [qx / len, qy / len, qz / len, qw / len];
}

function parseBindActor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 64);
}

function parseFloatList(value: unknown, max: number): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > max) return null;
  const out: number[] = [];
  for (const item of value) {
    const n = finiteNumber(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

function parseMesh(raw: unknown, index: number): SceneMesh | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = parseId(rec.id ?? rec.name, `mesh-${index}`);
  const kind = parseKind(rec.kind ?? rec.shape);
  const color = parseColor(rec.color ?? rec.colour);
  if (kind !== 'mesh') return { id, kind, color };
  const pos = parseFloatList(rec.positions ?? rec.verts ?? rec.vertices, MAX_VERTS * 3);
  const idx = parseFloatList(rec.indices ?? rec.tris, MAX_INDICES);
  if (!pos || pos.length < 9 || pos.length % 3 !== 0) return null;
  const vertCount = pos.length / 3;
  if (vertCount > MAX_VERTS) return null;
  if (!idx || idx.length < 3 || idx.length % 3 !== 0) return null;
  const indices = new Uint16Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= vertCount) return null;
    indices[i] = v;
  }
  const mesh: SceneMesh = {
    id,
    kind: 'mesh',
    color,
    positions: Float32Array.from(pos),
    indices,
  };
  const nrm = parseFloatList(rec.normals, MAX_VERTS * 3);
  if (nrm && nrm.length === pos.length) mesh.normals = Float32Array.from(nrm);
  return mesh;
}

function parseNode(
  raw: unknown,
  index: number,
  grid?: PlayerCodeGridBounds,
  defaultScale = 1,
): SceneNode | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const p = asRecord(rec.p) ?? asRecord(rec.pos) ?? asRecord(rec.position);
  const x = finiteNumber(rec.x ?? rec[0] ?? p?.x);
  const y = finiteNumber(rec.y ?? rec[1] ?? p?.y, 0.5);
  const z = finiteNumber(rec.z ?? rec[2] ?? p?.z);
  if (x === null || y === null || z === null) return null;
  const s = asRecord(rec.s) ?? asRecord(rec.scale);
  const uniform = finiteNumber(rec.r ?? rec.radius ?? rec.size);
  const fallback = uniform ?? defaultScale;
  const sx = clamp(finiteNumber(rec.sx ?? rec.w ?? s?.x, fallback) ?? fallback, MIN_SIZE, MAX_SIZE);
  const sy = clamp(finiteNumber(rec.sy ?? rec.h ?? s?.y, fallback) ?? fallback, MIN_SIZE, MAX_SIZE);
  const sz = clamp(finiteNumber(rec.sz ?? rec.d ?? s?.z, fallback) ?? fallback, MIN_SIZE, MAX_SIZE);
  const [qx, qy, qz, qw] = parseQuat(rec);
  const id = parseId(rec.id ?? rec.name, `obj-${index}`);
  let px = x;
  let py = y;
  let pz = z;
  if (grid) {
    const b = gridWorldBounds(grid);
    px = clamp(px, b.minX, b.maxX);
    py = clamp(py, b.minY, b.maxY);
    pz = clamp(pz, b.minZ, b.maxZ);
  }
  const parentRaw = rec.parent ?? rec.parentId;
  const meshRaw = rec.mesh ?? rec.meshId;
  const kind = parseKind(rec.kind ?? rec.shape);
  const visible = rec.visible === false || rec.hidden === true ? false : true;
  return {
    id,
    parent:
      typeof parentRaw === 'string' && parentRaw.trim()
        ? parentRaw.trim().slice(0, MAX_ID_CHARS)
        : undefined,
    mesh:
      typeof meshRaw === 'string' && meshRaw.trim()
        ? meshRaw.trim().slice(0, MAX_ID_CHARS)
        : undefined,
    kind,
    x: px,
    y: py,
    z: pz,
    qx,
    qy,
    qz,
    qw,
    sx,
    sy,
    sz,
    color: parseColor(rec.color ?? rec.colour),
    visible,
    bindActor: parseBindActor(rec.bindActor ?? rec.bind_actor ?? rec.actor),
  };
}

function toOverlay(node: SceneNode): ModOverlayObject {
  return { ...node, shape: node.kind };
}

/** CLIENT overlay_draw / local gizmos. Also accepts a catalog `{nodes,objects}`. */
export function parseOverlayPayload(
  payload: unknown,
  grid?: PlayerCodeGridBounds,
): ModOverlayObject[] {
  const rec = asRecord(payload);
  const list = rec
    ? Array.isArray(rec.objects)
      ? rec.objects
      : Array.isArray(rec.nodes)
        ? rec.nodes
        : Array.isArray(rec.shapes)
          ? rec.shapes
          : null
    : Array.isArray(payload)
      ? payload
      : null;
  const rows = list ?? (rec && (rec.x !== undefined || rec.z !== undefined) ? [rec] : []);
  const out: ModOverlayObject[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= MAX_NODES) break;
    const parsed = parseNode(row, out.length, grid, 0.2);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(toOverlay(parsed));
  }
  return out;
}

export function parseSceneCatalog(
  payload: unknown,
  grid?: PlayerCodeGridBounds,
): SceneCatalog | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const jsonBytes = (() => {
    try {
      return new TextEncoder().encode(JSON.stringify(rec)).length;
    } catch {
      return MAX_CATALOG_BYTES + 1;
    }
  })();
  if (jsonBytes > MAX_CATALOG_BYTES) return null;
  const version = finiteNumber(rec.v ?? rec.version, SCENE_VERSION) ?? SCENE_VERSION;
  if (version !== SCENE_VERSION) return null;
  const meshes: SceneMesh[] = [];
  const meshIds = new Set<string>();
  const meshList = Array.isArray(rec.meshes) ? rec.meshes : [];
  for (const row of meshList) {
    if (meshes.length >= MAX_MESHES) break;
    const mesh = parseMesh(row, meshes.length);
    if (!mesh || meshIds.has(mesh.id)) continue;
    meshIds.add(mesh.id);
    meshes.push(mesh);
  }
  const nodes: SceneNode[] = [];
  const nodeIds = new Set<string>();
  const nodeList = Array.isArray(rec.nodes)
    ? rec.nodes
    : Array.isArray(rec.objects)
      ? rec.objects
      : [];
  for (const row of nodeList) {
    if (nodes.length >= MAX_NODES) break;
    const node = parseNode(row, nodes.length, grid, 1);
    if (!node || nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);
    nodes.push(node);
  }
  const revision = Math.max(0, Math.floor(finiteNumber(rec.revision ?? rec.rev, 0) ?? 0));
  return { revision, meshes, nodes };
}

export function quatMultiply(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
): [number, number, number, number] {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function rotateByQuat(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const [ix, iy, iz, iw] = quatMultiply(qx, qy, qz, qw, x, y, z, 0);
  const [rx, ry, rz] = quatMultiply(ix, iy, iz, iw, -qx, -qy, -qz, qw);
  return [rx, ry, rz];
}

export function yawPitchQuat(yaw: number, pitch: number): [number, number, number, number] {
  const hy = yaw * 0.5;
  const hp = pitch * 0.5;
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cp = Math.cos(hp);
  const sp = Math.sin(hp);
  return normalizeQuat(sp * cy, cp * sy, -sp * sy, cp * cy);
}

function actorParent(actor: ActorXform): SceneNode {
  const [qx, qy, qz, qw] = yawPitchQuat(actor.yaw, actor.pitch);
  return {
    id: `actor:${actor.uuid}`,
    kind: 'capsule',
    x: actor.x,
    y: actor.y,
    z: actor.z,
    qx,
    qy,
    qz,
    qw,
    sx: 1,
    sy: 1,
    sz: 1,
    color: 0,
    visible: true,
  };
}

function hasParentCycle(nodes: Map<string, SceneNode>, start: string): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = start;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = nodes.get(cur)?.parent;
  }
  return false;
}

export function composeScene(
  nodes: readonly SceneNode[],
  meshes: readonly SceneMesh[],
  actors: readonly ActorXform[],
  grid?: PlayerCodeGridBounds,
): ComposedInstance[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const meshMap = new Map(meshes.map((m) => [m.id, m]));
  const actorMap = new Map(actors.map((a) => [a.uuid, a]));
  const aabb = grid ? gridWorldBounds(grid) : null;
  const world = new Map<string, ComposedInstance>();

  const resolve = (id: string): ComposedInstance | null => {
    const cached = world.get(id);
    if (cached) return cached;
    const node = nodeMap.get(id);
    if (!node || !node.visible) return null;
    if (hasParentCycle(nodeMap, id)) return null;

    let parent: Pick<
      ComposedInstance,
      'x' | 'y' | 'z' | 'qx' | 'qy' | 'qz' | 'qw' | 'sx' | 'sy' | 'sz'
    > | null = null;
    if (node.bindActor) {
      const actor = actorMap.get(node.bindActor);
      if (actor) {
        const ap = actorParent(actor);
        parent = ap;
      }
    } else if (node.parent) {
      parent = resolve(node.parent);
    }

    let x = node.x;
    let y = node.y;
    let z = node.z;
    let qx = node.qx;
    let qy = node.qy;
    let qz = node.qz;
    let qw = node.qw;
    let sx = node.sx;
    let sy = node.sy;
    let sz = node.sz;
    if (parent) {
      const [rx, ry, rz] = rotateByQuat(
        parent.qx,
        parent.qy,
        parent.qz,
        parent.qw,
        node.x * parent.sx,
        node.y * parent.sy,
        node.z * parent.sz,
      );
      x = parent.x + rx;
      y = parent.y + ry;
      z = parent.z + rz;
      [qx, qy, qz, qw] = normalizeQuat(
        ...quatMultiply(
          parent.qx,
          parent.qy,
          parent.qz,
          parent.qw,
          node.qx,
          node.qy,
          node.qz,
          node.qw,
        ),
      );
      sx = clamp(parent.sx * node.sx, MIN_SIZE, MAX_SIZE);
      sy = clamp(parent.sy * node.sy, MIN_SIZE, MAX_SIZE);
      sz = clamp(parent.sz * node.sz, MIN_SIZE, MAX_SIZE);
    }
    if (aabb) {
      x = clamp(x, aabb.minX, aabb.maxX);
      y = clamp(y, aabb.minY, aabb.maxY);
      z = clamp(z, aabb.minZ, aabb.maxZ);
    }
    const mesh = node.mesh ? meshMap.get(node.mesh) : undefined;
    const composed: ComposedInstance = {
      id: node.id,
      kind: mesh?.kind ?? node.kind,
      mesh,
      x,
      y,
      z,
      qx,
      qy,
      qz,
      qw,
      sx,
      sy,
      sz,
      color: node.color || mesh?.color || 0xf8fafc,
      visible: true,
    };
    world.set(id, composed);
    return composed;
  };

  const out: ComposedInstance[] = [];
  for (const node of nodes) {
    const composed = resolve(node.id);
    if (composed) out.push(composed);
  }
  return out;
}

export function applyPoses(
  nodes: readonly SceneNode[],
  poses: ReadonlyMap<string, SceneNode>,
): SceneNode[] {
  return nodes.map((node) => {
    const pose = poses.get(node.id);
    if (!pose) return node;
    return {
      ...node,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      qx: pose.qx,
      qy: pose.qy,
      qz: pose.qz,
      qw: pose.qw,
      sx: pose.sx,
      sy: pose.sy,
      sz: pose.sz,
      visible: pose.visible,
    };
  });
}

function scaleToByte(value: number): number {
  const t = (clamp(value, MIN_SIZE, MAX_SIZE) - MIN_SIZE) / (MAX_SIZE - MIN_SIZE);
  return Math.round(t * 255);
}

function scaleFromByte(value: number): number {
  return MIN_SIZE + (clamp(value, 0, 255) / 255) * (MAX_SIZE - MIN_SIZE);
}

function quatToI16(value: number): number {
  return Math.round(clamp(value, -1, 1) * 32767);
}

function quatFromI16(value: number): number {
  return clamp(value, -32767, 32767) / 32767;
}

/** Packed pose datagram (EventRouter state, no eventType prefix). */
const POSE_STRIDE = 24;

export function encodePosePacket(catalogRev: number, nodes: readonly SceneNode[]): Uint8Array {
  const count = Math.min(nodes.length, MAX_NODES);
  const bytes = new Uint8Array(5 + count * POSE_STRIDE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, catalogRev >>> 0, true);
  view.setUint8(4, count);
  let o = 5;
  for (let i = 0; i < count; i++) {
    const n = nodes[i]!;
    view.setUint8(o, i);
    view.setFloat32(o + 1, n.x, true);
    view.setFloat32(o + 5, n.y, true);
    view.setFloat32(o + 9, n.z, true);
    view.setInt16(o + 13, quatToI16(n.qx), true);
    view.setInt16(o + 15, quatToI16(n.qy), true);
    view.setInt16(o + 17, quatToI16(n.qz), true);
    view.setInt16(o + 19, quatToI16(n.qw), true);
    view.setUint8(o + 21, scaleToByte(n.sx));
    view.setUint8(o + 22, scaleToByte(n.sy));
    view.setUint8(o + 23, scaleToByte(n.sz));
    o += POSE_STRIDE;
  }
  return bytes.subarray(0, o);
}

export function decodePosePacket(
  bytes: Uint8Array,
  nodeIds: readonly string[],
): { catalogRev: number; poses: Map<string, SceneNode> } | null {
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const catalogRev = view.getUint32(0, true);
  const count = view.getUint8(4);
  if (count > MAX_NODES || bytes.length < 5 + count * POSE_STRIDE) return null;
  const poses = new Map<string, SceneNode>();
  let o = 5;
  for (let i = 0; i < count; i++) {
    const index = view.getUint8(o);
    const id = nodeIds[index];
    if (id) {
      const [qx, qy, qz, qw] = normalizeQuat(
        quatFromI16(view.getInt16(o + 13, true)),
        quatFromI16(view.getInt16(o + 15, true)),
        quatFromI16(view.getInt16(o + 17, true)),
        quatFromI16(view.getInt16(o + 19, true)),
      );
      poses.set(id, {
        id,
        kind: 'box',
        x: view.getFloat32(o + 1, true),
        y: view.getFloat32(o + 5, true),
        z: view.getFloat32(o + 9, true),
        qx,
        qy,
        qz,
        qw,
        sx: scaleFromByte(view.getUint8(o + 21)),
        sy: scaleFromByte(view.getUint8(o + 22)),
        sz: scaleFromByte(view.getUint8(o + 23)),
        color: 0,
        visible: true,
      });
    }
    o += POSE_STRIDE;
  }
  return { catalogRev, poses };
}

export function encodeCatalogChunks(revision: number, utf8: Uint8Array): Uint8Array[] {
  const maxData = MAX_EVENT_STATE_BYTES - CATALOG_CHUNK_HEADER;
  const parts = Math.max(1, Math.ceil(utf8.length / maxData));
  if (parts > 255) return [];
  const out: Uint8Array[] = [];
  for (let part = 0; part < parts; part++) {
    const slice = utf8.subarray(part * maxData, (part + 1) * maxData);
    const bytes = new Uint8Array(CATALOG_CHUNK_HEADER + slice.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, revision >>> 0, true);
    view.setUint8(4, part);
    view.setUint8(5, parts);
    view.setUint16(6, slice.length, true);
    bytes.set(slice, CATALOG_CHUNK_HEADER);
    out.push(bytes);
  }
  return out;
}

export function decodeCatalogChunk(
  bytes: Uint8Array,
): { revision: number; part: number; parts: number; data: Uint8Array } | null {
  if (bytes.length < CATALOG_CHUNK_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const revision = view.getUint32(0, true);
  const part = view.getUint8(4);
  const parts = view.getUint8(5);
  const n = view.getUint16(6, true);
  if (parts === 0 || part >= parts || bytes.length < CATALOG_CHUNK_HEADER + n) return null;
  return {
    revision,
    part,
    parts,
    data: bytes.subarray(CATALOG_CHUNK_HEADER, CATALOG_CHUNK_HEADER + n),
  };
}

export class CatalogAssembler {
  private revision = -1;
  private parts = 0;
  private slots: Array<Uint8Array | undefined> = [];

  push(bytes: Uint8Array): Uint8Array | null {
    const chunk = decodeCatalogChunk(bytes);
    if (!chunk) return null;
    if (chunk.revision !== this.revision) {
      this.revision = chunk.revision;
      this.parts = chunk.parts;
      this.slots = new Array(chunk.parts);
    }
    if (chunk.parts !== this.parts) return null;
    this.slots[chunk.part] = chunk.data;
    if (this.slots.some((s) => !s)) return null;
    const total = this.slots.reduce((n, s) => n + (s?.length ?? 0), 0);
    if (total > MAX_CATALOG_BYTES) {
      this.slots = [];
      return null;
    }
    const joined = new Uint8Array(total);
    let o = 0;
    for (const slot of this.slots) {
      joined.set(slot!, o);
      o += slot!.length;
    }
    this.slots = [];
    return joined;
  }
}

export function bytesFromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
