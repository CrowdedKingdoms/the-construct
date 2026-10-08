/**
 * SERVER-authoritative instances: catalog + packed poses arriving on the
 * World Stores EventRouter. Overlay nodes from CLIENT mods merge on top for
 * the local tab only.
 */
import { rawCodec, type EventRouter } from '@crowdedkingdoms/crowdyjs/stores';
import type { PlayerCodeGridBounds } from '@crowdedkingdoms/crowdyjs';

import {
  CatalogAssembler,
  EVENT_CATALOG,
  EVENT_POSES,
  applyPoses,
  bytesFromBase64,
  composeScene,
  decodePosePacket,
  parseSceneCatalog,
  type ActorXform,
  type ComposedInstance,
  type SceneCatalog,
  type SceneMesh,
  type SceneNode,
} from './instanceSchema';
import type { ModOverlayObject } from './modOverlay';

export interface InstanceSnapshot {
  revision: number;
  instances: readonly ComposedInstance[];
}

export interface InstanceSnapshotInput {
  overlay?: readonly ModOverlayObject[];
  actors?: readonly ActorXform[];
  grid?: PlayerCodeGridBounds;
  meshes?: readonly SceneMesh[];
}

export class InstanceStore {
  private catalog: SceneCatalog | null = null;
  private poses = new Map<string, SceneNode>();
  private revisionValue = 0;
  private readonly assembler = new CatalogAssembler();
  private readonly offs: Array<() => void> = [];

  constructor(private readonly events: EventRouter) {
    this.offs.push(
      events.on(EVENT_CATALOG, rawCodec, (event) => {
        this.ingestCatalog(event.value);
      }),
      events.on(EVENT_POSES, rawCodec, (event) => {
        this.ingestPoses(event.value);
      }),
    );
  }

  get revision(): number {
    return this.revisionValue;
  }

  get catalogRevision(): number {
    return this.catalog?.revision ?? 0;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.catalog = null;
    this.poses.clear();
  }

  snapshot(input: InstanceSnapshotInput = {}): InstanceSnapshot {
    const catalogNodes = this.catalog ? applyPoses(this.catalog.nodes, this.poses) : [];
    const overlay = input.overlay ?? [];
    const overlayIds = new Set(overlay.map((n) => n.id));
    const nodes: SceneNode[] = [...catalogNodes.filter((n) => !overlayIds.has(n.id)), ...overlay];
    const meshes = [...(this.catalog?.meshes ?? []), ...(input.meshes ?? [])];
    return {
      revision: this.revisionValue,
      instances: composeScene(nodes, meshes, input.actors ?? [], input.grid),
    };
  }

  private ingestCatalog(stateBase64: string): void {
    let bytes: Uint8Array;
    try {
      bytes = bytesFromBase64(stateBase64);
    } catch {
      return;
    }
    const joined = this.assembler.push(bytes);
    if (!joined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(joined));
    } catch {
      return;
    }
    const catalog = parseSceneCatalog(parsed);
    if (!catalog) return;
    if (this.catalog && this.catalog.revision === catalog.revision) return;
    this.catalog = catalog;
    this.poses.clear();
    this.revisionValue += 1;
  }

  private ingestPoses(stateBase64: string): void {
    if (!this.catalog) return;
    let bytes: Uint8Array;
    try {
      bytes = bytesFromBase64(stateBase64);
    } catch {
      return;
    }
    const decoded = decodePosePacket(
      bytes,
      this.catalog.nodes.map((n) => n.id),
    );
    if (!decoded || decoded.catalogRev !== this.catalog.revision) return;
    this.poses = decoded.poses;
    this.revisionValue += 1;
  }
}
