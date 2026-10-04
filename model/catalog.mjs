/**
 * The programs the holodeck offers: the one definition the pads (`src/game/programs.ts`) and
 * the world hub (`exec/construct/src/catalog.rs`, generated from this list by
 * `npm run build:exec-sources`) both use.
 *
 * Plain ES module on purpose: the Node scripts and the browser import the same list.
 */

/**
 * `programId` is the byte every pose carries (0 is the holodeck itself, so 1-255), `sceneId`
 * the scene the router loads.
 */
export const PROGRAM_CATALOG = [
  {
    programId: 1,
    sceneId: 'paint',
    name: 'Paint',
    description: 'A shared 2D canvas. Click to paint voxels everyone sees, live and persisted.',
  },
];
