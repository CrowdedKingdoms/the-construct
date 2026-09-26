/**
 * The game's world hub on ck-exec: the server this game's services ask for what the platform
 * does not keep for it (the world's pulse, the program catalog, the claim registry, each
 * player's progression). One connection per page, opened by the first call on the host that
 * runs the hub (`execConnect` with the app token) and closed with the game client.
 *
 * It is a keyed hub rather than the app's root, which the platform limits to 50 calls a
 * second, so per-player reads belong here. A game built on the framework runs its own hub and
 * names it once at boot with {@link configureWorldHub}; the defaults are the Construct
 * starter's (`exec/ckx.json`: type `world`, key `main`), so the starter needs no call.
 */
import type { CrowdyClient, ExecConnection } from '@crowdedkingdoms/crowdyjs';

export interface WorldHubAddress {
  nodeType: string;
  key: string;
}

let address: WorldHubAddress = { nodeType: 'world', key: 'main' };

/** Call once at boot, before the session starts. */
export function configureWorldHub(next: Partial<WorldHubAddress>): void {
  address = { ...address, ...next };
}

export function worldHubAddress(): WorldHubAddress {
  return address;
}

export class WorldHub {
  private connection: Promise<ExecConnection> | null = null;
  private closed = false;

  constructor(
    private readonly client: Pick<CrowdyClient, 'exec'>,
    private readonly appId: string,
  ) {}

  /**
   * One of the hub's endpoints. A refusal from the hub (not your claim, a missing argument)
   * throws a `CrowdyExecError` with status `AppError` and the hub's message; the platform's
   * own refusals throw it with their status.
   */
  async call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    const { nodeType, key } = address;
    const connection = await this.connect();
    return connection.call<T>(nodeType, key, method, args);
  }

  close(): void {
    this.closed = true;
    const pending = this.connection;
    this.connection = null;
    void pending?.then(
      (connection) => connection.close(),
      () => undefined,
    );
  }

  private connect(): Promise<ExecConnection> {
    if (this.closed) return Promise.reject(new Error('The world hub connection is closed'));
    this.connection ??= this.client.exec
      .connect(this.appId, { nodeType: address.nodeType, key: address.key })
      .catch((error: unknown) => {
        this.connection = null;
        throw error;
      });
    return this.connection;
  }
}
