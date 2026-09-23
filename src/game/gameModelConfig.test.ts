import { describe, expect, it } from 'vitest';

import {
  gameKitOptions,
  gameModelNames,
} from '@crowdedkingdoms/construct/platform/model/gameModelConfig';

import { MODEL_NAMES, kitOptions } from '../../model/blueprints.mjs';

describe('framework model defaults', () => {
  it('are the starter blueprints, so the starter runs unconfigured', () => {
    expect(gameModelNames()).toEqual(MODEL_NAMES);
    expect(gameKitOptions()).toEqual(kitOptions());
  });
});
