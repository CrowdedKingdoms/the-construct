/**
 * The game's content layer: everything Crowdy Studio's game editor can change
 * and preview without a rebuild. `main.ts` (the host) reads the game through
 * this module alone, so adding a scene is an entry here, a row in
 * `model/catalog.mjs` and a pad in `programs.ts`, never an edit to `main.ts`.
 *
 * Keep it to scenes and the data they read. Code outside what this module
 * imports (the HUD, `main.ts`, the framework, the world hub under `exec/`)
 * still needs a rebuild or a hub deploy to change.
 */
import { CONTENT_API, type GameContent } from '@crowdedkingdoms/construct/platform/live/content';

import { HOLODECK_SCENE_ID, HOLODECK_SPAWN, PROGRAMS } from '@/game/programs';
import { HolodeckScene } from '@/scenes/holodeck-three/HolodeckScene';
import { PaintScene } from '@/scenes/program-pixi/PaintScene';

const content: GameContent = {
  contentApi: CONTENT_API,
  scenes: {
    [HOLODECK_SCENE_ID]: () => new HolodeckScene(),
    paint: () => new PaintScene(),
  },
  home: { sceneId: HOLODECK_SCENE_ID, spawn: HOLODECK_SPAWN },
  programs: PROGRAMS,
};

export default content;
