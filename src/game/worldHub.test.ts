import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { worldHubAddress } from '@crowdedkingdoms/construct/platform/exec/worldHub';

import manifest from '../../exec/ckx.json';
import { PROGRAM_CATALOG } from '../../model/catalog.mjs';
import { staleFiles } from '../../scripts/build-exec-sources.mjs';
import { PROGRAMS } from './programs';

describe('the starter and its world hub agree', () => {
  it('the framework calls the hub exec/ckx.json deploys, by the key the hub accepts', () => {
    const { nodeType, key } = worldHubAddress();
    const types = manifest.types as Record<string, { client?: boolean; parent?: string }>;
    expect(types[nodeType]?.client).toBe(true);
    expect(nodeType).not.toBe(manifest.root);
    // vitest runs from the repository root.
    const lib = readFileSync(path.resolve('exec/construct/src/lib.rs'), 'utf8');
    expect(lib).toContain(`pub const WORLD_TYPE: &str = "${nodeType}";`);
    expect(lib).toContain(`pub const WORLD_KEY: &str = "${key}";`);
  });

  it('the generated catalog and starter mods are current (npm run build:exec-sources)', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('every program in the catalog has a pad', () => {
    expect(PROGRAMS.map((p) => p.programId)).toEqual(PROGRAM_CATALOG.map((p) => p.programId));
  });
});
