import { describe, expect, it } from 'vitest';
import type { EventRouter, StateCodec, TypedEvent } from '@crowdedkingdoms/crowdyjs/stores';
import {
  EVENT_CATALOG,
  EVENT_POSES,
  bytesToBase64,
  encodeCatalogChunks,
  encodePosePacket,
  parseSceneCatalog,
  type SceneNode,
} from './instanceSchema';
import { InstanceStore } from './instanceStore';

function fakeEvents(): EventRouter & { emit: (type: number, bytes: Uint8Array) => void } {
  const handlers = new Map<number, (event: { value: string }) => void>();
  return {
    on<T>(eventType: number, codec: StateCodec<T>, handler: (event: TypedEvent<T>) => void) {
      handlers.set(eventType, (event) =>
        handler({ ...event, value: codec.decode(event.value) } as TypedEvent<T>),
      );
      return () => handlers.delete(eventType);
    },
    emit(type: number, bytes: Uint8Array) {
      handlers.get(type)?.({ value: bytesToBase64(bytes) });
    },
  } as unknown as EventRouter & { emit: (type: number, bytes: Uint8Array) => void };
}

describe('InstanceStore', () => {
  it('renders SERVER catalog plus packed poses without CLIENT overlay', () => {
    const events = fakeEvents();
    const store = new InstanceStore(events);
    const catalog = {
      v: 1,
      revision: 3,
      meshes: [],
      nodes: [
        { id: 'table', kind: 'box', x: 8, y: 0.8, z: 8, sx: 2, sy: 0.2, sz: 1 },
        { id: 'cue', kind: 'box', x: 8, y: 1, z: 8, qx: 0, qy: 0, qz: 0, qw: 1 },
      ],
    };
    const utf8 = new TextEncoder().encode(JSON.stringify(catalog));
    for (const chunk of encodeCatalogChunks(3, utf8)) events.emit(EVENT_CATALOG, chunk);
    const parsed = parseSceneCatalog(catalog)!;
    const posed: SceneNode[] = parsed.nodes.map((n) =>
      n.id === 'cue' ? { ...n, qy: 0.7071, qw: 0.7071 } : n,
    );
    events.emit(EVENT_POSES, encodePosePacket(3, posed));
    const snap = store.snapshot();
    const cue = snap.instances.find((i) => i.id === 'cue');
    expect(cue?.qy).toBeCloseTo(0.7071, 2);
    expect(snap.instances.some((i) => i.id === 'table')).toBe(true);

    for (const chunk of encodeCatalogChunks(3, utf8)) events.emit(EVENT_CATALOG, chunk);
    const afterKeepalive = store.snapshot();
    expect(afterKeepalive.instances.find((i) => i.id === 'cue')?.qy).toBeCloseTo(0.7071, 2);
    store.dispose();
  });

  it('lets local overlay ids replace replicated ones in this tab only', () => {
    const events = fakeEvents();
    const store = new InstanceStore(events);
    const catalog = {
      v: 1,
      revision: 1,
      nodes: [{ id: 'marker', kind: 'box', x: 0, y: 1, z: 0 }],
    };
    for (const chunk of encodeCatalogChunks(1, new TextEncoder().encode(JSON.stringify(catalog)))) {
      events.emit(EVENT_CATALOG, chunk);
    }
    const snap = store.snapshot({
      overlay: [
        {
          id: 'marker',
          shape: 'sphere',
          kind: 'sphere',
          x: 4,
          y: 1,
          z: 4,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          sx: 0.3,
          sy: 0.3,
          sz: 0.3,
          color: 0xff0000,
          visible: true,
        },
      ],
    });
    expect(snap.instances).toHaveLength(1);
    expect(snap.instances[0]?.kind).toBe('sphere');
    expect(snap.instances[0]?.x).toBe(4);
    store.dispose();
  });
});
