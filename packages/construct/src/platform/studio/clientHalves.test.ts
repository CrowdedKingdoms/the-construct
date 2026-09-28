import { describe, expect, it, vi } from 'vitest';

// The SDK barrel pulls Monaco, which does not load under happy-dom; the runner and the
// Studio's project model are plain modules, so the tests drive the real ones.
vi.mock('@crowdedkingdoms/crowdyjs', async () => {
  const dist = '../../../../../node_modules/@crowdedkingdoms/crowdyjs/dist';
  const halves = await import(/* @vite-ignore */ `${dist}/grid-mods/exec-client-halves.js`);
  return { ExecClientHalves: halves.ExecClientHalves, PlayerCodeBroker: class {} };
});
vi.mock('@crowdedkingdoms/crowdyjs/crowdy-studio', async () => {
  const dist = '../../../../../node_modules/@crowdedkingdoms/crowdyjs/dist';
  const models = await import(/* @vite-ignore */ `${dist}/crowdy-studio/models.js`);
  return { projectTargets: models.projectTargets };
});

const {
  GridClientHalves,
  clientHalfSource,
  describeClientHalfPrompt,
  isOwnClientHalfPrompt,
  studioPreviewModName,
} = await import('./clientHalves');

const GRID = {
  gridId: '42',
  bounds: { low: { x: 5n, y: 0n, z: 5n }, high: { x: 5n, y: 0n, z: 5n } },
};
const SUMMARY = {
  version: 1,
  target: 'client' as const,
  imports: ['ck.host_call'],
  hostFunctions: ['hud_set', 'actors_list', 'user_state_get'],
  capabilityGroups: ['present', 'world_read', 'state'],
  presentationHooks: ['hud_set'],
  exportedFunctions: ['init', 'tick'],
};

function half(overrides: Record<string, unknown> = {}) {
  return {
    modId: 'm1',
    name: 'greeter',
    gridId: '42',
    authorId: '7',
    listingId: null,
    clientVersion: 1,
    digest: 'd1',
    capabilitySummaryJson: JSON.stringify(SUMMARY),
    capabilitySummary: SUMMARY,
    capabilityHash: 'h1',
    tickIntervalMs: 1000,
    callerConsented: false,
    authorCapabilitySummaryJson: JSON.stringify(SUMMARY),
    authorCapabilitySummary: SUMMARY,
    authorCapabilityHash: 'ah1',
    callerTrustsAuthor: false,
    updatedAt: '2026-09-27T00:00:00Z',
    ...overrides,
  };
}

function harness(
  options: {
    listings?: Array<Array<ReturnType<typeof half>>>;
    self?: string;
    confirm?: (prompt: unknown, signal: AbortSignal) => Promise<boolean>;
    filter?: (mod: { name: string }) => boolean;
    log?: (line: string) => void;
  } = {},
) {
  const listings = options.listings ?? [[half({ callerConsented: true })]];
  let listed = 0;
  const exec = {
    gridClientMods: vi.fn(async () => listings[Math.min(listed++, listings.length - 1)]!),
    consentClientMod: vi.fn(async () => true),
    trustAuthor: vi.fn(async () => true),
    modClientArtifactBytes: vi.fn(async (_appId: string, modId: string) => {
      const mod = listings.flat().find((m) => m.modId === modId)!;
      return {
        modId,
        name: mod.name,
        gridId: mod.gridId,
        clientVersion: mod.clientVersion,
        bytes: new ArrayBuffer(8),
        digest: mod.digest,
        sizeBytes: 8,
        fuelPerDispatch: 1_000_000n,
        tickIntervalMs: mod.tickIntervalMs,
        capabilitySummaryJson: mod.capabilitySummaryJson,
        capabilitySummary: SUMMARY,
        capabilityHash: mod.capabilityHash,
        abiVersion: 0,
      };
    }),
  };
  const brokers: Array<{
    options: {
      onHostCall(call: unknown): Promise<unknown>;
      onPresentation?(presentation: unknown): void;
      onLog?(line: unknown): void;
      consentedHostCalls?: readonly string[];
      engine?: string;
    };
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const hud = { set: vi.fn(), remove: vi.fn() };
  const overlay = { apply: vi.fn(), remove: vi.fn() };
  const actorsInChunk = vi.fn(() => [{ uuid: 'u1', name: 'neo' }]);
  const serverCall = vi.fn(async () => ({ state: 'from the server' }));
  const serverCalls = vi.fn(() => serverCall);
  const changes: number[] = [];
  const halves = new GridClientHalves({
    exec: () => exec as never,
    appId: '1',
    workerUrl: '/glue.js',
    selfUserId: () => options.self ?? '9',
    reads: { actorsInChunk, chunkVoxels: () => null },
    serverCalls,
    hud: hud as never,
    overlay: overlay as never,
    ...(options.confirm ? { confirm: options.confirm as never } : {}),
    ...(options.filter ? { filter: options.filter as never } : {}),
    ...(options.log ? { log: options.log } : {}),
    onChange: (running) => changes.push(running.length),
    brokerFactory: (brokerOptions) => {
      const broker = { options: brokerOptions as never, stop: vi.fn() };
      brokers.push(broker);
      return {
        start: async () => {},
        stop: broker.stop,
        invoke: async (payload: Uint8Array) => new Uint8Array([...payload].reverse()),
      };
    },
  });
  return { halves, exec, brokers, hud, overlay, actorsInChunk, serverCall, serverCalls, changes };
}

describe('GridClientHalves', () => {
  it('runs a consented CLIENT half into the HUD and answers its host calls through the game', async () => {
    const h = harness();
    h.halves.enterGrid(GRID);
    await h.halves.refresh();

    expect(h.halves.running.map((m) => m.modId)).toEqual(['m1']);
    expect(h.changes).toEqual([1]);
    const [broker] = h.brokers;
    expect(broker!.options.engine).toBe('ck-exec');
    expect(broker!.options.consentedHostCalls).toEqual(SUMMARY.hostFunctions);

    broker!.options.onPresentation?.({ channel: 'hud', payload: { greeting: 'hi' } });
    expect(h.hud.set).toHaveBeenCalledWith({
      source: 'grid:m1',
      label: 'greeter',
      payload: { greeting: 'hi' },
    });
    broker!.options.onPresentation?.({ channel: 'overlay', payload: { objects: [] } });
    expect(h.overlay.apply).toHaveBeenCalledWith('grid:m1', { objects: [] }, GRID.bounds);

    await expect(
      broker!.options.onHostCall({ fn: 'actors_list', args: { x: '5', y: '0', z: '5' } }),
    ).resolves.toEqual({ actors: [{ uuid: 'u1', name: 'neo' }] });
    expect(h.actorsInChunk).toHaveBeenCalledWith(5n, 0n, 5n);
    // What the game's router does not offer goes to the grid's server calls.
    await expect(
      broker!.options.onHostCall({ fn: 'user_state_get', args: { userId: '9' } }),
    ).resolves.toEqual({ state: 'from the server' });
    expect(h.serverCalls).toHaveBeenCalledWith(GRID);
  });

  it("forwards a CLIENT half's log lines and invokes its handle_invoke", async () => {
    const lines: string[] = [];
    const h = harness({ log: (line) => lines.push(line) });
    h.halves.enterGrid(GRID);
    await h.halves.refresh();
    h.brokers[0]!.options.onLog?.({ level: 'info', message: 'ready', moduleName: 'greeter' });
    expect(lines).toContain('CLIENT half of mod greeter info: ready');
    await expect(h.halves.invoke('m1', new Uint8Array([1, 2, 3]))).resolves.toEqual(
      new Uint8Array([3, 2, 1]),
    );
    await expect(h.halves.invoke('nope', new Uint8Array())).rejects.toThrow();
  });

  it('asks about another author, and a yes trusts them at the hash the grid listed', async () => {
    const asked: unknown[] = [];
    const h = harness({
      listings: [[half()], [half({ callerTrustsAuthor: true, callerConsented: true })]],
      confirm: async (prompt) => {
        asked.push(prompt);
        return true;
      },
    });
    h.halves.enterGrid(GRID);
    await h.halves.refresh();

    expect(asked).toHaveLength(1);
    expect(h.exec.trustAuthor).toHaveBeenCalledWith('1', '42', '7', 'ah1');
    expect(h.halves.running.map((m) => m.modId)).toEqual(['m1']);
  });

  it('runs the player’s own CLIENT halves without asking', async () => {
    const confirm = vi.fn(async () => false);
    const h = harness({
      self: '7',
      listings: [[half()], [half({ callerTrustsAuthor: true, callerConsented: true })]],
      confirm,
    });
    h.halves.enterGrid(GRID);
    await h.halves.refresh();

    expect(confirm).not.toHaveBeenCalled();
    expect(h.exec.trustAuthor).toHaveBeenCalledWith('1', '42', '7', 'ah1');
    expect(h.halves.running).toHaveLength(1);
  });

  it('asks the owner about a CLIENT half installed from someone’s listing', async () => {
    const confirm = vi.fn(async () => false);
    const h = harness({ self: '7', listings: [[half({ listingId: '55' })]], confirm });
    h.halves.enterGrid(GRID);
    await h.halves.refresh();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(h.exec.trustAuthor).not.toHaveBeenCalled();
    expect(h.halves.running).toHaveLength(0);
  });

  it('runs nothing unconsented when the game asks nothing', async () => {
    const h = harness({ listings: [[half()]] });
    h.halves.enterGrid(GRID);
    await h.halves.refresh();

    expect(h.exec.trustAuthor).not.toHaveBeenCalled();
    expect(h.brokers).toHaveLength(0);
  });

  it('leaves out what the filter refuses, such as the half Crowdy Studio previews', async () => {
    const h = harness({ filter: (mod) => mod.name !== 'greeter' });
    h.halves.enterGrid(GRID);
    await h.halves.refresh();

    expect(h.brokers).toHaveLength(0);
    expect(h.exec.modClientArtifactBytes).not.toHaveBeenCalled();
  });

  it('stops its CLIENT halves and clears their HUD when the player leaves the grid', async () => {
    const h = harness();
    h.halves.enterGrid(GRID);
    await h.halves.refresh();
    const [broker] = h.brokers;

    h.halves.enterGrid(null);
    expect(broker!.stop).toHaveBeenCalled();
    expect(h.hud.remove).toHaveBeenCalledWith('grid:m1');
    expect(h.overlay.remove).toHaveBeenCalledWith('grid:m1');
    expect(h.changes).toEqual([1, 0]);
    // A late call from the stopped half does not reach the game.
    await expect(
      broker!.options.onHostCall({ fn: 'actors_list', args: { x: '5', y: '0', z: '5' } }),
    ).rejects.toThrow(/no longer in this CLIENT half/);
    expect(h.actorsInChunk).not.toHaveBeenCalled();
  });

  it('withdraws an unanswered question when the player leaves the grid', async () => {
    let signal: AbortSignal | null = null;
    const h = harness({
      listings: [[half()]],
      confirm: (_prompt, s) =>
        new Promise((resolve) => {
          signal = s;
          s.addEventListener('abort', () => resolve(false));
        }),
    });
    h.halves.enterGrid(GRID);
    const refreshed = h.halves.refresh();
    await vi.waitFor(() => expect(signal).not.toBeNull());

    h.halves.enterGrid({ ...GRID, gridId: '43' });
    expect(signal!.aborted).toBe(true);
    await refreshed;
    expect(h.exec.trustAuthor).not.toHaveBeenCalled();
  });
});

describe('client half prompts', () => {
  it('names the author, the halves, anything installed, and the host calls', () => {
    const text = describeClientHalfPrompt(
      {
        kind: 'author',
        gridId: '42',
        authorId: '7',
        capabilityHash: 'ah1',
        capabilitySummaryJson: JSON.stringify(SUMMARY),
        capabilitySummary: SUMMARY,
        mods: [half(), half({ modId: 'm2', name: 'shop', listingId: '55' })] as never,
      },
      'trinity',
    );
    expect(text.split('\n')[0]).toBe("Run trinity's code on this grid?");
    expect(text).toContain('greeter, shop will run in a sandbox in your browser');
    expect(text).toContain('Installed from the marketplace: shop.');
    expect(text).toContain('• host calls: hud_set, actors_list, user_state_get');
    expect(text).toContain('• groups: present, world_read, state');
  });

  it('asks about one CLIENT half, and shows a summary that does not parse as it is', () => {
    const text = describeClientHalfPrompt({
      kind: 'mod',
      gridId: '42',
      authorId: '7',
      capabilityHash: 'h1',
      capabilitySummaryJson: '{"odd":true}',
      capabilitySummary: null,
      mods: [half()] as never,
    });
    expect(text.split('\n')[0]).toBe('Run the CLIENT half of greeter by player 7?');
    expect(text).toContain('{"odd":true}');
  });

  it('counts only the player’s own, self-written halves as theirs', () => {
    const prompt = (mods: unknown[]) =>
      ({ kind: 'author', gridId: '42', authorId: '7', mods }) as never;
    expect(isOwnClientHalfPrompt(prompt([half()]), '7')).toBe(true);
    expect(isOwnClientHalfPrompt(prompt([half()]), '8')).toBe(false);
    expect(isOwnClientHalfPrompt(prompt([half()]), null)).toBe(false);
    expect(isOwnClientHalfPrompt(prompt([half(), half({ listingId: '55' })]), '7')).toBe(false);
  });

  it('keys the HUD by mod id', () => {
    expect(clientHalfSource({ modId: 'abc' })).toBe('grid:abc');
  });
});

describe('studioPreviewModName', () => {
  const project = (kind: string, metadata: Record<string, string>) => ({ kind, metadata }) as never;

  it('is the server module of a full-stack project and the client module of a CLIENT one', () => {
    expect(
      studioPreviewModName(
        project('FULL_STACK', { serverModuleName: 'shop-server', clientModuleName: 'shop-client' }),
      ),
    ).toBe('shop-server');
    expect(studioPreviewModName(project('CLIENT', { clientModuleName: ' hud-client ' }))).toBe(
      'hud-client',
    );
  });

  it('is none for a SERVER-only project, which previews no CLIENT half', () => {
    expect(studioPreviewModName(project('SERVER', { serverModuleName: 'beacon' }))).toBeNull();
  });
});
