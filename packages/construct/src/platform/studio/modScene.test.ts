import { describe, expect, it } from 'vitest';

import { ModSceneStore } from './modScene';

const catalog = {
  v: 1,
  revision: 1,
  nodes: [
    { id: 'body', kind: 'box', x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, visible: false },
    {
      id: 'pelvis',
      parent: 'body',
      kind: 'box',
      x: 0,
      y: 1,
      z: 0,
      sx: 0.4,
      sy: 0.2,
      sz: 0.3,
      color: 1,
    },
  ],
};

describe('ModSceneStore', () => {
  it('keeps one template and clones it per instance', () => {
    const store = new ModSceneStore();
    expect(store.setCatalog('mod', catalog)).toEqual({ ok: true, revision: 1 });
    expect(store.setCatalog('mod', catalog)).toEqual({ ok: true, revision: 1, ignored: true });
    store.setInstances('mod', {
      instances: [
        { id: 'me', template: 'body', x: 10, y: 0, z: 3, sx: 2, sy: 2, sz: 2 },
        { id: 'bob', template: 'body', bindActor: 'bob-uuid' },
      ],
    });
    const nodes = store.expand();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      id: 'mod/me/pelvis',
      x: 10,
      y: 2,
      z: 3,
      sy: 0.4,
    });
    expect(nodes[0]?.bindActor).toBeUndefined();
    expect(nodes[1]).toMatchObject({
      id: 'mod/bob/pelvis',
      x: 0,
      y: 1,
      z: 0,
      sy: 0.2,
      bindActor: 'bob-uuid',
    });
    expect(store.boundActors()).toEqual(new Set(['bob-uuid']));
  });

  it('drops the previous geometries when the revision changes', () => {
    const store = new ModSceneStore();
    store.setCatalog('mod', catalog);
    store.setInstances('mod', { instances: [{ id: 'me', template: 'body' }] });
    expect(store.expand()).toHaveLength(1);
    store.setCatalog('mod', {
      v: 1,
      revision: 2,
      nodes: [{ id: 'body', kind: 'box', visible: false, x: 0, y: 0, z: 0 }],
    });
    expect(store.expand()).toEqual([]);
  });

  it('omits an instance whose scale is folded away', () => {
    const store = new ModSceneStore();
    store.setCatalog('mod', catalog);
    store.setInstances('mod', {
      instances: [{ id: 'me', template: 'body', sx: 0, sy: 0, sz: 0 }],
    });
    expect(store.expand()).toEqual([]);
    expect(store.boundActors().size).toBe(0);
  });
});
