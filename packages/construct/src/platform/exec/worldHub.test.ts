import { describe, expect, it, vi } from 'vitest';

import { WorldHub, configureWorldHub, worldHubAddress } from './worldHub';

function fakeClient(connectResults: Array<'fail' | 'ok'> = ['ok']) {
  const connection = {
    call: vi.fn(async (_type: string, _key: string, method: string) => ({ method })),
    close: vi.fn(),
  };
  const exec = {
    connect: vi.fn(async () => {
      if (connectResults.shift() === 'fail') throw new Error('Unavailable: no host');
      return connection;
    }),
  };
  return { client: { exec } as never, exec, connection };
}

describe('WorldHub', () => {
  it('opens one connection, on the host running the hub, for every call', async () => {
    const { client, exec, connection } = fakeClient();
    const hub = new WorldHub(client, '77');
    const [status] = await Promise.all([hub.call('status'), hub.call('claims', { mine: true })]);
    expect(status).toEqual({ method: 'status' });
    expect(exec.connect).toHaveBeenCalledTimes(1);
    expect(exec.connect).toHaveBeenCalledWith('77', { nodeType: 'world', key: 'main' });
    expect(connection.call).toHaveBeenCalledWith('world', 'main', 'claims', { mine: true });
  });

  it('waits before dialling again after a failed connect, and never dials after close', async () => {
    vi.useFakeTimers();
    try {
      const { client, exec, connection } = fakeClient(['fail', 'ok']);
      const hub = new WorldHub(client, '77');
      await expect(hub.call('world')).rejects.toThrow(/no host/);
      await expect(hub.call('world')).rejects.toThrow(/no host/);
      expect(exec.connect).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(15_000);
      await hub.call('world');
      expect(exec.connect).toHaveBeenCalledTimes(2);
      hub.close();
      await Promise.resolve();
      expect(connection.close).toHaveBeenCalledTimes(1);
      await expect(hub.call('world')).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls the hub a game names at boot', async () => {
    configureWorldHub({ key: 'eu' });
    try {
      expect(worldHubAddress()).toEqual({ nodeType: 'world', key: 'eu' });
      const { client, connection } = fakeClient();
      await new WorldHub(client, '77').call('status');
      expect(connection.call).toHaveBeenCalledWith('world', 'eu', 'status', undefined);
    } finally {
      configureWorldHub({ nodeType: 'world', key: 'main' });
    }
  });
});
