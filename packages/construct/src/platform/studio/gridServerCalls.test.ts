import { describe, expect, it, vi } from 'vitest';

// The SDK barrel pulls Monaco, which does not load under happy-dom; the host-call module is
// plain, so the test drives the real one.
vi.mock('@crowdedkingdoms/crowdyjs', async () => {
  const dist = '../../../../../node_modules/@crowdedkingdoms/crowdyjs/dist';
  const calls = await import(/* @vite-ignore */ `${dist}/grid-mods/grid-host-calls.js`);
  return { createGridHostCalls: calls.createGridHostCalls };
});

const { gridServerCalls } = await import('./gridServerCalls');

const BOUNDS = { low: { x: '5', y: '0', z: '5' }, high: { x: '5', y: '0', z: '5' } };

function game() {
  const grid = vi.fn((appId: string, gridId: string, box: unknown) => ({
    appId,
    gridId,
    bounds: box,
    assertContains: () => {},
    channels: { list: async () => [] },
  }));
  return { grid } as never;
}

const check = (userId: string, permissionKey: string) => ({
  fn: 'grid_permission_check',
  args: { userId, gridId: '42', permissionKey },
});

describe('gridServerCalls', () => {
  it("answers grid_permission_check for the signed-in player from the grid's keys", async () => {
    const calls = gridServerCalls({
      game: game(),
      appId: '1',
      gridId: '42',
      bounds: BOUNDS,
      userId: '9',
      permissionKeys: () => ['write_client_code', 'run_client_code'],
    });
    await expect(calls(check('9', 'run_client_code') as never)).resolves.toBe(true);
    await expect(calls(check('9', 'write_server_code') as never)).resolves.toBe(false);
    await expect(calls(check('8', 'run_client_code') as never)).rejects.toThrow(/another player/);
  });

  it('refuses it when no player is signed in', async () => {
    const calls = gridServerCalls({
      game: game(),
      appId: '1',
      gridId: '42',
      bounds: BOUNDS,
      userId: null,
      permissionKeys: () => ['run_client_code'],
    });
    await expect(calls(check('9', 'run_client_code') as never)).rejects.toThrow();
  });
});
