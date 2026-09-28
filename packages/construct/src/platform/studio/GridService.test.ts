import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK root barrel drags Monaco into a unit test; the network layer only needs the constants.
vi.mock('@crowdedkingdoms/crowdyjs', () => ({
  CROWDY_DEFAULT_HTTP_ORIGIN: 'https://ck.test.example',
  CROWDY_DEFAULT_TIER: 'test',
}));

const { GridService } = await import('./GridService');

interface HubClaim {
  gridId: string;
  chunk: { x: number; y: number; z: number };
  ownerUserId: string;
  ownerName: string;
}

/** A network whose world hub keeps a registry the way `exec/construct` does. */
function network(userId = '42') {
  const claims: HubClaim[] = [];
  const logs: string[] = [];
  const hub = {
    call: vi.fn(async (method: string, args: Record<string, unknown> = {}) => {
      if (method === 'claims') {
        const at = args.chunk as HubClaim['chunk'];
        const rows = claims.filter((c) => !at || (c.chunk.x === at.x && c.chunk.z === at.z));
        return { claims: rows, total: claims.length };
      }
      if (method === 'record_claim') {
        if (claims.some((c) => c.gridId === args.gridId && c.ownerUserId !== userId))
          throw new Error('AppError: grid is recorded for another player');
        if (!claims.some((c) => c.gridId === args.gridId)) {
          claims.push({
            gridId: String(args.gridId),
            chunk: args.chunk as HubClaim['chunk'],
            ownerUserId: userId,
            ownerName: String(args.ownerName),
          });
        }
        return { recorded: true };
      }
      if (method === 'release_claim') {
        const i = claims.findIndex((c) => c.gridId === args.gridId);
        if (i >= 0 && claims[i]!.ownerUserId !== userId)
          throw new Error("AppError: only the claim's owner may release it");
        if (i >= 0) claims.splice(i, 1);
        return { released: i >= 0 };
      }
      throw new Error(`unexpected ${method}`);
    }),
  };
  const marketplace = {
    claimGridChunk: vi.fn(async () => ({
      gridId: '91159989710848',
      lowChunk: { x: '3', y: '0', z: '-2' },
      highChunk: { x: '3', y: '0', z: '-2' },
      effectivePermissionKeys: ['write_server_code', 'run_server_code'],
      policy: 'SELF_CLAIM',
    })),
    releaseClaimedGrid: vi.fn(async () => true),
  };
  const gameApps = {
    nearbyPermissions: vi.fn(async () => {
      throw new Error('manage_apps required');
    }),
  };
  const net = {
    appId: '77',
    user: { userId, gamertag: 'neo' },
    game: { marketplace, gameApps },
    worldHub: hub,
    log: (line: string) => logs.push(line),
  };
  return { net: net as never, hub, claims, logs, marketplace };
}

const AT = { x: 3, y: 0, z: -2 };

describe('GridService on the world hub registry', () => {
  beforeEach(() => localStorage.clear());

  it('records a claim for the caller and finds it again', async () => {
    const { net, hub, claims } = network();
    const grids = new GridService(net);
    const snapshot = await grids.claimHere(AT, 'neo the one with a very long name indeed');
    expect(snapshot).toMatchObject({ gridId: '91159989710848', owned: true });
    expect(hub.call).toHaveBeenCalledWith('record_claim', {
      gridId: '91159989710848',
      chunk: AT,
      ownerName: 'neo the one with a very long nam',
    });
    expect(claims).toHaveLength(1);
    expect(await grids.lookup(AT)).toMatchObject({ gridId: '91159989710848', owned: true });
  });

  it('shows a visitor the owner from the registry, with no code keys', async () => {
    const owner = network('42');
    await new GridService(owner.net).claimHere(AT, 'neo');
    localStorage.clear();
    const visitor = network('43');
    visitor.claims.push(...owner.claims);
    const grid = await new GridService(visitor.net).lookup(AT);
    expect(grid).toMatchObject({ gridId: '91159989710848', owned: false, ownerName: 'neo' });
    expect(grid?.permissions.server.canWrite).toBe(false);
    expect(await new GridService(visitor.net).lookup({ x: 9, y: 0, z: 9 })).toBeNull();
  });

  it('caches a chunk briefly and releases through the platform, then the registry', async () => {
    const { net, hub, claims, marketplace } = network();
    const grids = new GridService(net);
    await grids.claimHere(AT, 'neo');
    await grids.lookup(AT);
    await grids.lookup(AT);
    expect(hub.call.mock.calls.filter(([m]) => m === 'claims')).toHaveLength(1);
    await grids.release('91159989710848');
    expect(marketplace.releaseClaimedGrid).toHaveBeenCalledWith({
      appId: '77',
      gridId: '91159989710848',
    });
    expect(claims).toHaveLength(0);
    expect(grids.ownedGrids()).toHaveLength(0);
  });

  it('keeps a claim working when the registry refuses the row, and says why', async () => {
    const { net, claims, logs } = network('42');
    claims.push({ gridId: '91159989710848', chunk: AT, ownerUserId: '43', ownerName: 'smith' });
    const snapshot = await new GridService(net).claimHere(AT, 'neo');
    expect(snapshot.owned).toBe(true);
    expect(logs.some((line) => /claim registry write failed: AppError/.test(line))).toBe(true);
  });
});
