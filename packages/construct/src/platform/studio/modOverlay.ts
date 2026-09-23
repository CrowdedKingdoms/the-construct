/**
 * CLIENT `overlay_draw` is local presentation on the same construct.scene.v1
 * nodes the replicated instance layer uses. The mod never touches the DOM.
 */
import type { PlayerCodeGridBounds } from '@crowdedkingdoms/crowdyjs';

import {
  MAX_OVERLAY_OBJECTS,
  parseOverlayPayload,
  type ModOverlayObject,
  type ModOverlayShape,
} from './instanceSchema';

export { MAX_OVERLAY_OBJECTS, parseOverlayPayload, type ModOverlayObject, type ModOverlayShape };

export interface ModOverlaySnapshot {
  revision: number;
  objects: readonly ModOverlayObject[];
}

/** Latest overlay from every running CLIENT source, keyed by source id. */
export class ModOverlayStore {
  private readonly bySource = new Map<string, ModOverlayObject[]>();
  private revisionValue = 0;

  get revision(): number {
    return this.revisionValue;
  }

  snapshot(): ModOverlaySnapshot {
    const objects: ModOverlayObject[] = [];
    for (const rows of this.bySource.values()) objects.push(...rows);
    return { revision: this.revisionValue, objects };
  }

  apply(source: string, payload: unknown, grid?: PlayerCodeGridBounds): void {
    this.bySource.set(source, parseOverlayPayload(payload, grid));
    this.revisionValue += 1;
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
