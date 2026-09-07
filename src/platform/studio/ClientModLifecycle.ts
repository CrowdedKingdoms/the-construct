/**
 * Owns the worker handles of grid-attached CLIENT mods independently of any
 * scene. Every metadata refresh reconciles immutable hashes; changing grids
 * synchronously tears everything down; a worker that finishes starting after
 * a grid change (or shutdown) is stopped instead of attached stale.
 */
export interface ClientModDescriptor {
  attachmentId: string;
  artifactHash: string;
  capabilityHash: string;
}

export interface ClientModHandle {
  stop: () => void;
}

export interface ClientModScope {
  gridId: string;
  generation: number;
}

interface RunningClientMod extends ClientModDescriptor, ClientModHandle {}

export class ClientModLifecycle {
  private readonly running = new Map<string, RunningClientMod>();
  private activeGridId: string | null = null;
  private generation = 0;
  private stopped = false;

  /** Returns true when the grid actually changed (callers reset their caches). */
  enterGrid(gridId: string | null): boolean {
    if (this.stopped) return false;
    if (gridId === this.activeGridId) return false;
    this.stopAll();
    this.activeGridId = gridId;
    this.generation++;
    return true;
  }

  get currentGridId(): string | null {
    return this.activeGridId;
  }

  has(attachmentId: string): boolean {
    return this.running.has(attachmentId);
  }

  get runningCount(): number {
    return this.running.size;
  }

  scope(gridId: string): ClientModScope | null {
    if (this.stopped || gridId !== this.activeGridId) return null;
    return { gridId, generation: this.generation };
  }

  isCurrent(scope: ClientModScope): boolean {
    return !this.stopped && scope.gridId === this.activeGridId && scope.generation === this.generation;
  }

  track(scope: ClientModScope, descriptor: ClientModDescriptor, handle: ClientModHandle): boolean {
    if (!this.isCurrent(scope) || this.running.has(descriptor.attachmentId)) {
      handle.stop();
      return false;
    }
    this.running.set(descriptor.attachmentId, { ...descriptor, ...handle });
    return true;
  }

  /** Stop mods that disappeared or changed hash; returns false if scope is stale. */
  reconcile(scope: ClientModScope, descriptors: readonly ClientModDescriptor[]): boolean {
    if (!this.isCurrent(scope)) return false;
    const current = new Map(descriptors.map((d) => [d.attachmentId, d]));
    for (const [attachmentId, running] of this.running) {
      const next = current.get(attachmentId);
      if (!next || next.artifactHash !== running.artifactHash || next.capabilityHash !== running.capabilityHash) {
        running.stop();
        this.running.delete(attachmentId);
      }
    }
    return true;
  }

  private stopAll(): void {
    for (const running of this.running.values()) running.stop();
    this.running.clear();
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.activeGridId = null;
    this.generation++;
    this.stopAll();
  }
}
