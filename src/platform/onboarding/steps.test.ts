import { describe, expect, it, vi } from 'vitest';

vi.mock('@crowdedkingdoms/crowdyjs', () => ({
  progressionBlueprint: (o: unknown) => ({ name: 'progression', options: o }),
  leaderboardsBlueprint: (o: unknown) => ({ name: 'leaderboards', options: o }),
}));

const steps = await import('@/platform/onboarding/steps.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function identityStub(overrides: Any = {}): Any {
  const created: Any[] = [];
  return {
    created,
    organizations: {
      mine: vi.fn(async () => overrides.orgs ?? []),
      create: vi.fn(async (input: Any) => {
        created.push(['org', input]);
        return { orgId: '1', slug: input.slug, name: input.name };
      }),
    },
    apps: {
      forOrg: vi.fn(async () => overrides.apps ?? []),
      placeableDatacenters: vi.fn(async () => ({
        datacenters: overrides.datacenters ?? [
          { code: 'va', placeable: true, serving: true, appShardCount: 9 },
          { code: 'or', placeable: true, serving: true, appShardCount: 2 },
          { code: 'zz', placeable: false, serving: true, appShardCount: 0 },
        ],
      })),
      create: vi.fn(async (input: Any) => {
        created.push(['app', input]);
        return { appId: '77', name: input.name, slug: input.slug };
      }),
    },
    appAccess: {
      tiers: vi.fn(async () => overrides.tiers ?? []),
      createTier: vi.fn(async (input: Any) => {
        created.push(['tier', input]);
        return { tierId: 't1', name: input.name, permissionKeys: input.permissionKeys };
      }),
      updateTier: vi.fn(async (id: string, input: Any) => {
        created.push(['tierUpdate', id, input]);
        return { tierId: id, name: 'Constructor', permissionKeys: input.permissionKeys };
      }),
      myAccess: vi.fn(async () => overrides.myAccess ?? null),
      grant: vi.fn(async (input: Any) => {
        created.push(['grant', input]);
        return { tierId: input.tierId };
      }),
    },
  };
}

describe('onboarding steps', () => {
  it('slugifies names conservatively', () => {
    expect(steps.slugify("Neo's Studio!")).toBe('neo-s-studio');
    expect(steps.slugify('   ')).toBe('construct');
  });

  it('creates an org only when the account has none', async () => {
    const fresh = identityStub();
    const a = await steps.ensureOrganization(fresh as never, { name: 'My studio' });
    expect(a.created).toBe(true);
    expect(fresh.organizations.create).toHaveBeenCalledWith({
      name: 'My studio',
      slug: 'my-studio',
    });

    const existing = identityStub({
      orgs: [{ org: { orgId: '5', slug: 'x', name: 'X' }, permissions: ['manage_apps'] }],
    });
    const b = await steps.ensureOrganization(existing as never, { name: 'ignored' });
    expect(b.created).toBe(false);
    expect(b.org.orgId).toBe('5');
    expect(existing.organizations.create).not.toHaveBeenCalled();
  });

  it('reuses an app by slug and otherwise picks the least-loaded placeable datacenter', async () => {
    const reuse = identityStub({ apps: [{ appId: '9', slug: 'the-construct', name: 'Old' }] });
    const a = await steps.ensureApp(reuse as never, {
      orgId: '1',
      orgSlug: 'o',
      name: 'The Construct',
      slug: 'the-construct',
    });
    expect(a.created).toBe(false);
    expect(reuse.apps.create).not.toHaveBeenCalled();

    const fresh = identityStub();
    const b = await steps.ensureApp(fresh as never, {
      orgId: '1',
      orgSlug: 'o',
      name: 'The Construct',
      slug: 'the-construct',
    });
    expect(b.created).toBe(true);
    expect(fresh.apps.create.mock.calls[0][0].datacenter).toBe('or');
  });

  it('refuses when no datacenter can place an app', async () => {
    const none = identityStub({ datacenters: [{ code: 'or', placeable: false, serving: true }] });
    await expect(
      steps.ensureApp(none as never, { orgId: '1', orgSlug: 'o', name: 'A', slug: 'a' }),
    ).rejects.toThrow(/No datacenter/);
  });

  it('creates the Constructor tier with the code keys, widens the default tier, and grants once', async () => {
    const fresh = identityStub({
      tiers: [
        {
          tierId: 'd',
          name: 'Default',
          isDefault: true,
          status: 'active',
          permissionKeys: ['access'],
        },
      ],
    });
    const a = await steps.ensureConstructorTier(fresh as never, { appId: '77', userId: '42' });
    expect(a.created).toBe(true);
    expect(a.granted).toBe(true);
    const tierInput = fresh.appAccess.createTier.mock.calls[0][0];
    expect(tierInput.permissionKeys).toEqual(
      expect.arrayContaining([...steps.CONSTRUCTOR_TIER_KEYS]),
    );
    expect(tierInput.isDefault).toBe(false);
    const defaultUpdate = (fresh.appAccess.updateTier.mock.calls as Any[][]).find(
      (c) => c[0] === 'd',
    );
    expect(defaultUpdate?.[1].permissionKeys).toEqual(
      expect.arrayContaining([...steps.VISITOR_RUN_KEYS]),
    );
    expect(fresh.appAccess.grant).toHaveBeenCalledWith({ appId: '77', userId: '42', tierId: 't1' });

    const already = identityStub({
      tiers: [
        {
          tierId: 'd',
          name: 'Default',
          isDefault: true,
          status: 'active',
          permissionKeys: ['access', ...steps.VISITOR_RUN_KEYS],
        },
        {
          tierId: 't1',
          name: 'Constructor',
          status: 'active',
          permissionKeys: [...steps.CONSTRUCTOR_TIER_KEYS],
        },
      ],
      myAccess: { tierId: 't1', status: 'active' },
    });
    const b = await steps.ensureConstructorTier(already as never, { appId: '77', userId: '42' });
    expect(b.created).toBe(false);
    expect(b.granted).toBe(false);
    expect(already.appAccess.grant).not.toHaveBeenCalled();
    expect(already.appAccess.updateTier).not.toHaveBeenCalled();
  });

  it('only sets the claim policy when it differs', async () => {
    const game = {
      marketplace: {
        gridClaimPolicy: vi.fn(async () => 'SELF_CLAIM'),
        setGridClaimPolicy: vi.fn(),
      },
    };
    expect(await steps.ensureSelfClaimPolicy(game as never, { appId: '77' })).toEqual({
      policy: 'SELF_CLAIM',
      changed: false,
    });
    expect(game.marketplace.setGridClaimPolicy).not.toHaveBeenCalled();
    game.marketplace.gridClaimPolicy = vi.fn(async () => 'APPROVAL');
    expect(await steps.ensureSelfClaimPolicy(game as never, { appId: '77' })).toEqual({
      policy: 'SELF_CLAIM',
      changed: true,
    });
  });

  it('does not re-seed containers that already exist', async () => {
    const deploy = vi.fn(async () => ({
      seed: { containersCreated: 0 },
      automations: [],
      warnings: [],
    }));
    const game = {
      kit: () => ({ deploy }),
      gameModel: {
        containers: vi.fn(async ({ typeName }: Any) =>
          typeName === 'WorldState' ? [{ displayName: 'The Construct' }] : [],
        ),
      },
    };
    await steps.deployModel(game as never, { appId: '77' });
    const blueprints = (deploy.mock.calls as Any[][])[0]![0] as Any[];
    const world = blueprints.find((b) => b.name === 'construct-world')!;
    expect(world.containers.map((c: Any) => c.typeName)).toEqual(['Program']);
  });

  it('keeps use_studio_agent on Constructor and off the visitor default', () => {
    expect(steps.CONSTRUCTOR_TIER_KEYS).toContain('use_studio_agent');
    expect(steps.VISITOR_RUN_KEYS).not.toContain('use_studio_agent');
  });

  it('enables platform then app agent policy when the catalog is empty', async () => {
    const query = vi.fn(async (document: string, _variables?: Any) => {
      if (document.includes('ConstructSetAgentPlatform')) {
        return {
          cpSetCrowdyStudioAgentPlatformPolicy: {
            enabled: true,
            killSwitch: false,
            allowedModelIds: [steps.STUDIO_AGENT_MODEL],
            allowedModes: [...steps.STUDIO_AGENT_MODES],
            revision: '1',
          },
        };
      }
      if (document.includes('ConstructSetAgentPolicy')) {
        return {
          setCrowdyStudioAgentPolicy: {
            enabled: true,
            killSwitch: false,
            allowedModelIds: [steps.STUDIO_AGENT_MODEL],
            allowedModes: [...steps.STUDIO_AGENT_MODES],
            revision: '1',
          },
        };
      }
      if (document.includes('ConstructAgentPlatform')) {
        return { cpCrowdyStudioAgentPlatformPolicy: { enabled: false, revision: '0' } };
      }
      return {
        crowdyStudioAgentPolicy: { enabled: false, revision: '0' },
        crowdyStudioAgentEffectivePolicy: { enabled: false, revision: '0' },
      };
    });
    const identity = { graphql: { query } };
    const result = await steps.ensureAgentPolicy(identity as never, { appId: '77' });
    expect(result).toEqual({ enabled: true, skipped: false });
    const platformInput = (
      query.mock.calls.find((c: Any[]) => String(c[0]).includes('ConstructSetAgentPlatform'))?.[1] as
        | { input: Any }
        | undefined
    )?.input;
    expect(platformInput).toEqual(
      expect.objectContaining({
        enabled: true,
        killSwitch: false,
        allowedModelIds: [steps.STUDIO_AGENT_MODEL],
        allowedToolNames: [...steps.STUDIO_AGENT_TOOLS],
        idempotencyKey: 'construct-agent-platform-v1',
      }),
    );
    const appInput = (
      query.mock.calls.find((c: Any[]) => String(c[0]).includes('ConstructSetAgentPolicy'))?.[1] as
        | { input: Any }
        | undefined
    )?.input;
    expect(appInput).toEqual(
      expect.objectContaining({
        appId: '77',
        enabled: true,
        allowedModelIds: [steps.STUDIO_AGENT_MODEL],
        idempotencyKey: 'construct-agent-app-77-v1',
      }),
    );
    expect(appInput?.allowedToolNames).toBeUndefined();
  });

  it('skips writes when effective policy already allows Ask/Build/Play', async () => {
    const ready = {
      enabled: true,
      killSwitch: false,
      allowedModelIds: [steps.STUDIO_AGENT_MODEL],
      allowedModes: [...steps.STUDIO_AGENT_MODES],
    };
    const query = vi.fn(async (document: string, _variables?: Any) => {
      if (document.includes('ConstructAgentPlatform')) {
        return { cpCrowdyStudioAgentPlatformPolicy: ready };
      }
      return {
        crowdyStudioAgentPolicy: ready,
        crowdyStudioAgentEffectivePolicy: ready,
      };
    });
    const result = await steps.ensureAgentPolicy({ graphql: { query } } as never, { appId: '77' });
    expect(result).toEqual({ enabled: true, skipped: true });
    expect(query.mock.calls.some((c) => String(c[0]).includes('mutation'))).toBe(false);
  });

  it('stays green when the caller cannot see operator policy', async () => {
    const query = vi.fn(async (document: string, _variables?: Any) => {
      if (document.includes('ConstructAgentPlatform')) {
        throw new Error('FORBIDDEN');
      }
      throw new Error('manage_compute required');
    });
    const lines: string[] = [];
    const result = await steps.ensureAgentPolicy({ graphql: { query } } as never, { appId: '77' }, (line) =>
      lines.push(line),
    );
    expect(result).toEqual({ enabled: false, skipped: true });
    expect(lines.some((line) => /Studio → your app → Agent/.test(line))).toBe(true);
  });
});
