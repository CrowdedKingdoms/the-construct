/**
 * Wireframe AABB around grids this player owns so the claimed chunk is
 * visible in the holodeck (the floor grid alone does not mark a claim).
 */
import * as THREE from 'three';

import {
  toBrokerBounds,
  type GridBounds,
} from '@crowdedkingdoms/construct/platform/studio/permissions';
import {
  gridWorldBounds,
  type WorldAabb,
} from '@crowdedkingdoms/construct/platform/studio/instanceSchema';

/** Lift the floor so the box does not z-fight the holodeck grid. */
const FLOOR_LIFT = 0.05;
/** Amber against the teal holodeck grid. */
const COLOR = 0xffc14a;
const FLOOR_OPACITY = 0.16;

export interface ClaimedChunkSpec {
  gridId: string;
  bounds: GridBounds;
}

/** Every grid this player owns, plus the grid underfoot when it is theirs. */
export function claimedChunksToDraw(studio: {
  grid: { gridId: string; bounds: GridBounds; owned: boolean } | null;
  grids: { ownedGrids(): { gridId: string; bounds: GridBounds }[] };
}): ClaimedChunkSpec[] {
  const byId = new Map<string, ClaimedChunkSpec>();
  for (const record of studio.grids.ownedGrids()) {
    byId.set(record.gridId, { gridId: record.gridId, bounds: record.bounds });
  }
  const standing = studio.grid;
  if (standing?.owned) {
    byId.set(standing.gridId, { gridId: standing.gridId, bounds: standing.bounds });
  }
  return [...byId.values()];
}

export function claimedChunkAabb(bounds: GridBounds): WorldAabb {
  return gridWorldBounds(toBrokerBounds(bounds));
}

export function claimedChunkBoxTransform(aabb: WorldAabb): {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
} {
  const minY = aabb.minY + FLOOR_LIFT;
  return {
    x: (aabb.minX + aabb.maxX) / 2,
    y: (minY + aabb.maxY) / 2,
    z: (aabb.minZ + aabb.maxZ) / 2,
    sx: Math.max(0.01, aabb.maxX - aabb.minX),
    sy: Math.max(0.01, aabb.maxY - minY),
    sz: Math.max(0.01, aabb.maxZ - aabb.minZ),
  };
}

interface Entry {
  group: THREE.Group;
  lines: THREE.LineSegments;
  floor: THREE.Mesh;
  shell: THREE.Mesh;
}

export class ClaimedChunkLayer {
  private readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly edgeGeometry: THREE.EdgesGeometry;
  private readonly floorGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly lineMaterial = new THREE.LineBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  private readonly floorMaterial = new THREE.MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: FLOOR_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  /** Outward faces only: solid from outside, open once the camera is inside. */
  private readonly shellGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly shellMaterial = new THREE.MeshBasicMaterial({
    color: 0x141820,
    side: THREE.FrontSide,
    depthWrite: true,
    fog: false,
  });

  constructor(scene: THREE.Scene) {
    this.edgeGeometry = new THREE.EdgesGeometry(this.shellGeometry);
    this.group.name = 'claimed-chunks';
    this.group.renderOrder = 10;
    scene.add(this.group);
  }

  sync(grids: readonly ClaimedChunkSpec[]): void {
    const want = new Set(grids.map((grid) => grid.gridId));
    for (const [id, entry] of this.entries) {
      if (want.has(id)) continue;
      this.group.remove(entry.group);
      this.entries.delete(id);
    }
    for (const grid of grids) {
      const t = claimedChunkBoxTransform(claimedChunkAabb(grid.bounds));
      let entry = this.entries.get(grid.gridId);
      if (!entry) {
        const chunk = new THREE.Group();
        chunk.name = `claimed-chunk:${grid.gridId}`;
        const shell = new THREE.Mesh(this.shellGeometry, this.shellMaterial);
        const lines = new THREE.LineSegments(this.edgeGeometry, this.lineMaterial);
        const floor = new THREE.Mesh(this.floorGeometry, this.floorMaterial);
        floor.rotation.x = -Math.PI / 2;
        chunk.add(shell);
        chunk.add(lines);
        chunk.add(floor);
        this.group.add(chunk);
        entry = { group: chunk, lines, floor, shell };
        this.entries.set(grid.gridId, entry);
      }
      entry.shell.position.set(0, 0, 0);
      entry.shell.scale.set(t.sx, t.sy, t.sz);
      entry.lines.position.set(0, 0, 0);
      entry.lines.scale.set(t.sx, t.sy, t.sz);
      entry.floor.position.set(0, -t.sy / 2, 0);
      entry.floor.scale.set(t.sx, t.sz, 1);
      entry.group.position.set(t.x, t.y, t.z);
      entry.group.visible = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.entries.clear();
    this.edgeGeometry.dispose();
    this.shellGeometry.dispose();
    this.floorGeometry.dispose();
    this.lineMaterial.dispose();
    this.shellMaterial.dispose();
    this.floorMaterial.dispose();
  }
}
