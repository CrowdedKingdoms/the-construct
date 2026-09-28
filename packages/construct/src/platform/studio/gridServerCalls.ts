/**
 * The CLIENT host calls a game's own router does not answer (DN-10): channels, sessions, user
 * and avatar state, spatial sends and `grid_permission_check`, through CrowdyJS's
 * `createGridHostCalls`, confined to one grid and answered as the player running the module.
 * `grid_permission_check` needs both the player's user id and the keys the game holds for them
 * on the grid; without either the SDK refuses it.
 */
import {
  createGridHostCalls,
  type CrowdyClient,
  type PlayerCodeHostCall,
} from '@crowdedkingdoms/crowdyjs';

import { toBrokerBounds, type GridBounds } from './permissions';

export interface GridServerCallsOptions {
  game: CrowdyClient;
  appId: string;
  gridId: string;
  bounds: GridBounds;
  /** The signed-in player, the only one `grid_permission_check` answers about. */
  userId: string | null | undefined;
  /** The permission keys the game holds for that player on this grid. */
  permissionKeys: () => Iterable<string>;
}

export function gridServerCalls(
  options: GridServerCallsOptions,
): (call: PlayerCodeHostCall) => Promise<unknown> {
  const { game, appId, gridId, bounds, userId, permissionKeys } = options;
  return createGridHostCalls({
    scope: game.grid(appId, gridId, toBrokerBounds(bounds)),
    client: game,
    ...(userId ? { userId: String(userId) } : {}),
    local: { gridPermissionKeys: permissionKeys },
  });
}
