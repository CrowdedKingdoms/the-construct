/**
 * The World Stores chunk cache's settings, shared by the session and its test.
 */
import { REPLICATION_DISTANCE } from '../config';

export function chunkStoreConfig() {
  return {
    distance: REPLICATION_DISTANCE,
    // A SERVER mod's or hub's `world.set_voxels`, `updateVoxel` and realtime
    // voxel updates reach a reload only as `getChunk` `voxelStates` entries
    // (ck-api v2.33.0): the bulk load's dense `voxels` hold none of them. The
    // store hydrates every loaded chunk only when asked, or when it has a voxel
    // state codec, which The Construct does not.
    hydrateVoxelStates: true,
    // The Construct has no terrain to generate: a chunk the server has never
    // stored is simply empty. Seed it locally (no write-back) so the paint
    // program and CLIENT mods always see a dense grid.
    onMissing: () => ({ voxels: new Uint8Array(4096), writeBack: false }),
  };
}
