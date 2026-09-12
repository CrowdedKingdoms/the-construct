/**
 * Self-service onboarding: from "I have an account" to "my app is ready to
 * play and mod", using only the public API a signed-in developer can call.
 *
 * Every step is idempotent and reports whether it changed anything, so the
 * whole sequence can be re-run after editing the model or the templates, and
 * so a step that fails half-way can be retried without cleanup. Plain ES
 * module: the browser Setup wizard and `scripts/setup.mjs` run the same code.
 *
 * Tokens: steps 1-3, the tier grant, and the Studio Agent policy use the
 * IDENTITY session (org and app administration). Everything on the game plane
 * (claim policy, model, Studio common files) uses an APP-SCOPED token minted
 * for the new app — the caller supplies `enterApp(appId)` which returns a game
 * client holding one.
 */
import { constructBlueprints } from '../../../model/blueprints.mjs';
import { STARTER_TEMPLATES, commonFilesFor } from '../../../mods/templates/index.mjs';

/**
 * Seeding a model twice reports "created 0" the second time; that is the
 * idempotency working, not a failure. The counts are for the log.
 */

export const CONSTRUCTOR_TIER_NAME = 'Constructor';

/** Default free-tier keys, the webcam key, and the four Crowdy Studio code keys. */
export const CONSTRUCTOR_TIER_KEYS = [
  'access',
  'teleport',
  'update_voxel_data',
  'use_voice_chat',
  'use_video_chat',
  'write_server_code',
  'run_server_code',
  'write_client_code',
  'run_client_code',
  'use_studio_agent',
];

/** Priced ZDR model on hosted tiers; app policy inherits the platform catalog. */
export const STUDIO_AGENT_MODEL = 'openai/gpt-oss-120b';
export const STUDIO_AGENT_MODES = ['ASK', 'BUILD', 'PLAY'];

/**
 * What every visitor gets: the default free tier's keys plus permission to RUN
 * mods others wrote. Fetching a grid-attached CLIENT artifact is gated on the
 * VISITOR holding `run_client_code` (measured 2026-09-07: "Attachment not
 * found" without it), so a default tier without it means nobody ever sees
 * anyone's mod. Writing code stays on the Constructor tier.
 */
export const VISITOR_RUN_KEYS = ['run_server_code', 'run_client_code'];

export function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'construct'
  );
}

/** 1. Use the caller's first org, or create one. */
export async function ensureOrganization(identity, { name, slug }, log = noop) {
  const mine = await identity.organizations.mine();
  const owned =
    mine.find((m) => Array.isArray(m.permissions) && m.permissions.includes('manage_apps')) ??
    mine[0];
  if (owned) {
    log(`Using organization "${owned.org.name}" (${owned.org.slug})`);
    return { org: owned.org, created: false, permissions: owned.permissions ?? [] };
  }
  const org = await identity.organizations.create({ name, slug: slugify(slug ?? name) });
  log(`Created organization "${org.name}" (${org.slug})`);
  return { org, created: true, permissions: ['manage_apps', 'manage_access_tiers'] };
}

/** 2. Use the org's app with this slug, or create it on a placeable datacenter. */
export async function ensureApp(identity, { orgId, orgSlug, name, slug, datacenter }, log = noop) {
  const existing = await identity.apps.forOrg(orgSlug);
  const match = existing.find((app) => app.slug === slug) ?? null;
  if (match) {
    log(`Using app "${match.name}" (${match.appId})`);
    return { app: match, created: false };
  }
  const placement = await identity.apps.placeableDatacenters();
  const choices = (placement.datacenters ?? []).filter((dc) => dc.placeable && dc.serving);
  const pick = datacenter
    ? choices.find((dc) => dc.code === datacenter)
    : choices.sort((a, b) => Number(a.appShardCount ?? 0) - Number(b.appShardCount ?? 0))[0];
  if (!pick) {
    throw new Error(
      `No datacenter can place an app right now${datacenter ? ` (asked for "${datacenter}")` : ''}. ` +
        `Placeable: ${choices.map((dc) => dc.code).join(', ') || 'none'}.`,
    );
  }
  const app = await identity.apps.create({
    orgId,
    name,
    slug,
    datacenter: pick.code,
    description: 'Created by The Construct starter.',
  });
  log(`Created app "${app.name}" (${app.appId}) in datacenter ${pick.code}`);
  return { app, created: true };
}

/**
 * 3. A "Constructor" access tier carrying the Crowdy Studio code keys, and a
 * grant of that tier to the developer. Visitors keep the default free tier the
 * app was created with (access/teleport/voxels/voice), so they can play and
 * paint but not deploy code on grids they do not own.
 */
/**
 * Register the origins this game is served from as the app's redirect URIs.
 *
 * Since ck-api v1.88.0 this list is load-bearing twice over: it is where the
 * hosted sign-in may send a player back, AND it is the API's CORS allow-list
 * for the app. A game on an origin that is not here gets `HOSTED_SIGN_IN_REQUIRED`
 * on the return leg and no CORS headers on anything else. Idempotent: existing
 * entries are kept, the given ones added; origin-matched by the server, so the
 * path does not matter but `/` keeps the list readable.
 */
export async function ensureRedirectUris(identity, { appId, origins }, log = noop) {
  const app = await identity.apps.app(appId);
  const existing = Array.isArray(app?.redirectUris) ? app.redirectUris : [];
  const have = new Set(existing.map((u) => originOf(u)).filter(Boolean));
  const wanted = origins.map((o) => originOf(o)).filter(Boolean);
  const missing = [...new Set(wanted)].filter((o) => !have.has(o));
  if (missing.length === 0) {
    log(`Redirect URIs already cover ${wanted.join(', ')}`);
    return { redirectUris: existing, added: [] };
  }
  const redirectUris = [...existing, ...missing.map((o) => `${o}/`)];
  await identity.portal.setAppClientSettings({ appId, redirectUris });
  log(`Registered redirect origin(s) ${missing.join(', ')}`);
  return { redirectUris, added: missing };
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export async function ensureConstructorTier(identity, { appId, userId }, log = noop) {
  const tiers = await identity.appAccess.tiers(appId);

  // Visitors (default tier) may run mods; only Constructors may write them.
  const defaultTier = tiers.find((t) => t.isDefault && t.status !== 'archived');
  if (defaultTier) {
    const have = new Set((defaultTier.permissionKeys ?? []).map(String));
    if (!VISITOR_RUN_KEYS.every((key) => have.has(key))) {
      await identity.appAccess.updateTier(defaultTier.tierId, {
        permissionKeys: [...new Set([...have, ...VISITOR_RUN_KEYS])],
      });
      log(
        `Default tier "${defaultTier.name}" now lets visitors run mods (${VISITOR_RUN_KEYS.join(', ')})`,
      );
    }
  }

  let tier = tiers.find((t) => t.name === CONSTRUCTOR_TIER_NAME && t.status !== 'archived') ?? null;
  let created = false;
  let updated = false;
  if (!tier) {
    tier = await identity.appAccess.createTier({
      appId,
      name: CONSTRUCTOR_TIER_NAME,
      isFree: true,
      isDefault: false,
      description:
        'The Construct developer tier: play, paint, write SERVER + CLIENT mods, and use Crowdy Agent.',
      permissionKeys: CONSTRUCTOR_TIER_KEYS,
    });
    created = true;
    log(`Created access tier "${CONSTRUCTOR_TIER_NAME}" (${tier.tierId})`);
  } else {
    const have = new Set((tier.permissionKeys ?? []).map(String));
    if (!CONSTRUCTOR_TIER_KEYS.every((key) => have.has(key))) {
      tier = await identity.appAccess.updateTier(tier.tierId, {
        permissionKeys: [...new Set([...have, ...CONSTRUCTOR_TIER_KEYS])],
      });
      updated = true;
      log(`Updated access tier "${CONSTRUCTOR_TIER_NAME}" with the code keys`);
    }
  }
  // Check before granting rather than replaying an idempotency key: on
  // 2026-09-07 the replay path of grantAppAccess answered a DateTime
  // serialization error on dev, and "already on this tier" is the honest
  // idempotent answer anyway.
  const mine = await identity.appAccess.myAccess(appId).catch(() => null);
  if (mine && String(mine.tierId) === String(tier.tierId) && mine.status !== 'revoked') {
    log(`User ${userId} already holds "${CONSTRUCTOR_TIER_NAME}"`);
    return { tier, created, updated, granted: false };
  }
  await identity.appAccess.grant({ appId, userId, tierId: tier.tierId });
  log(`Granted "${CONSTRUCTOR_TIER_NAME}" to user ${userId}`);
  return { tier, created, updated, granted: true };
}

/** 4. Players may claim an unowned chunk for themselves (the Claim pad). */
export async function ensureSelfClaimPolicy(game, { appId }, log = noop) {
  const current = await game.marketplace.gridClaimPolicy({ appId }).catch(() => null);
  if (current === 'SELF_CLAIM') {
    log('Grid claim policy already SELF_CLAIM');
    return { policy: 'SELF_CLAIM', changed: false };
  }
  await game.marketplace.setGridClaimPolicy({ appId, policy: 'SELF_CLAIM' });
  log(`Grid claim policy set to SELF_CLAIM${current ? ` (was ${current})` : ''}`);
  return { policy: 'SELF_CLAIM', changed: true };
}

/**
 * 5. Deploy the game model (kit blueprints).
 *
 * `gameModelSeed` upserts DEFINITIONS (types, properties, functions) by name,
 * but seed CONTAINERS are instances and are created every time they are sent.
 * Re-running a seed that lists containers therefore duplicates them — measured
 * on 2026-09-07: two runs, two `WorldState`s. So before deploying, drop every
 * seed container whose type already has an instance with the same display
 * name. Definitions still refresh; existing data is left alone.
 */
export async function deployModel(game, { appId }, log = noop) {
  const blueprints = constructBlueprints();
  for (const blueprint of blueprints) {
    if (!blueprint.containers?.length) continue;
    const keep = [];
    const seenTypes = new Map();
    for (const container of blueprint.containers) {
      let existing = seenTypes.get(container.typeName);
      if (!existing) {
        existing = await game.gameModel
          .containers({ appId, typeName: container.typeName })
          .catch(() => []);
        seenTypes.set(container.typeName, existing);
      }
      if (existing.some((row) => row.displayName === container.displayName)) {
        log(
          `Container "${container.displayName}" (${container.typeName}) already exists; not re-seeding`,
        );
      } else {
        keep.push(container);
      }
    }
    blueprint.containers = keep;
  }
  const result = await game.kit(appId).deploy(blueprints);
  const seed = result.seed ?? {};
  log(
    `Model deployed: ${seed.containerTypesCreated ?? 0} new types, ` +
      `${seed.functionsCreated ?? 0} new functions, ${seed.containersCreated ?? 0} new containers, ` +
      `${result.automations?.length ?? 0} automations upserted`,
  );
  for (const warning of result.warnings ?? seed.warnings ?? []) log(`  seed warning: ${warning}`);
  return result;
}

const PUBLISH_COMMON = `mutation PublishCommon($input: PublishCrowdyStudioCommonFileInput!) {
  crowdyStudioCommonPublish(input: $input) { commonFileId slug versionId versionNo }
}`;

/** 6. Publish the starter templates' entrypoints to the Studio's Common Files. */
export async function publishStarterFiles(game, { appId }, log = noop) {
  const existing = await game.crowdyStudio.listCommonFiles({ appId, gridId: '' });
  const results = [];
  for (const common of STARTER_TEMPLATES.flatMap(commonFilesFor)) {
    const current = existing.find(
      (file) => file.title === common.title && file.content === common.content,
    );
    if (current) {
      log(`Common file "${common.slug}" already current`);
      results.push({ slug: common.slug, status: 'current' });
      continue;
    }
    const data = await game.graphql.query(PUBLISH_COMMON, {
      input: {
        appId,
        slug: common.slug,
        title: common.title,
        description: common.description,
        path: common.path,
        target: common.target,
        tags: common.tags,
        content: common.content,
        idempotencyKey: `construct-common-${common.slug}-${simpleHash(common.content)}`,
      },
    });
    const version = data?.crowdyStudioCommonPublish?.versionNo;
    log(`Common file "${common.slug}" published (v${version ?? '?'})`);
    results.push({ slug: common.slug, status: 'published', versionNo: version });
  }
  return results;
}

const AGENT_POLICY_CORE = `
  revision enabled killSwitch allowedModelIds allowedModes disableReasonCode
`;

const AGENT_APP_POLICY_QUERY = `query ConstructAgentPolicy($appId: BigInt!) {
  crowdyStudioAgentPolicy(appId: $appId) { ${AGENT_POLICY_CORE} }
  crowdyStudioAgentEffectivePolicy(appId: $appId) { ${AGENT_POLICY_CORE} }
}`;

const SET_AGENT_APP_POLICY = `mutation ConstructSetAgentPolicy($input: SetCrowdyStudioAgentAppPolicyInput!) {
  setCrowdyStudioAgentPolicy(input: $input) { ${AGENT_POLICY_CORE} }
}`;

/** App row is on and allows Ask/Build/Play. Models inherit the platform catalog. */
function appPolicyArmed(policy) {
  if (!policy || policy.enabled !== true || policy.killSwitch === true) return false;
  const modes = (policy.allowedModes ?? []).map(String);
  return STUDIO_AGENT_MODES.every((m) => modes.includes(m));
}

function catalogVisible(policy) {
  if (!policy || policy.killSwitch === true) return false;
  return (policy.allowedModelIds ?? []).length > 0;
}

/**
 * Arm Agentic Crowdy Studio for this app only.
 *
 * The dock stays fail-closed until the *app* policy is enabled and the
 * player's Constructor tier holds `use_studio_agent`. The platform catalog is
 * an operator concern — this starter never reads or writes `cp*` fields.
 * Agent tokens are platform-funded; this does not touch a player wallet or an
 * OpenRouter key in the game.
 */
export async function ensureAgentPolicy(identity, { appId }, log = noop) {
  let app;
  let effective;
  try {
    const data = await identity.graphql.query(AGENT_APP_POLICY_QUERY, { appId });
    app = data?.crowdyStudioAgentPolicy;
    effective = data?.crowdyStudioAgentEffectivePolicy;
  } catch (error) {
    log(
      `Studio Agent app policy is not readable (${messageOf(error)}). ` +
        'Needs manage_compute. Enable it in Studio → your app → Agent.',
    );
    return { enabled: false, skipped: true };
  }

  if (appPolicyArmed(effective) || appPolicyArmed(app)) {
    if (effective && !catalogVisible(effective)) {
      log(
        'Studio Agent app policy is on, but the platform catalog is not published. ' +
          'The dock stays closed until an operator publishes it. Studio → your app → Agent.',
      );
    } else {
      log('Studio Agent app policy already enabled');
    }
    return { enabled: true, skipped: true };
  }

  try {
    const updated = (
      await identity.graphql.query(SET_AGENT_APP_POLICY, {
        input: {
          appId,
          enabled: true,
          killSwitch: false,
          // Explicit on purpose: unlike tools and risk classes, modes have no
          // inherit-on-omit at the app layer ("there is no inherit-on-empty for
          // modes" -- SetCrowdyStudioAgentPolicyInput). PLAY is included because
          // the HUD promises "Play can walk for you".
          allowedModes: STUDIO_AGENT_MODES,
          expectedRevision: app?.revision ?? '0',
          idempotencyKey: `construct-agent-app-${appId}-v2`,
        },
      })
    )?.setCrowdyStudioAgentPolicy;
    let latestEffective = effective;
    try {
      latestEffective = (await identity.graphql.query(AGENT_APP_POLICY_QUERY, { appId }))
        ?.crowdyStudioAgentEffectivePolicy;
    } catch {
      // The write is what matters; effective is best-effort for the log.
    }
    const armed = appPolicyArmed(updated) || updated?.enabled === true;
    if (!armed) {
      log(
        `Studio Agent app policy written but not yet effective (${updated?.disableReasonCode ?? 'unknown'}). ` +
          'Studio → your app → Agent. The dock stays hidden until that row is live.',
      );
      return { enabled: false, skipped: false };
    }
    if (latestEffective && !catalogVisible(latestEffective)) {
      log(
        'Studio Agent app policy enabled; platform catalog not published — ' +
          'Studio → your app → Agent; dock stays closed.',
      );
    } else {
      log('Studio Agent app policy enabled (platform-funded; no player OpenRouter key)');
    }
    return { enabled: true, skipped: false };
  } catch (error) {
    log(
      `Could not enable the Studio Agent app policy (${messageOf(error)}). ` +
        'Studio → your app → Agent. The dock stays hidden until that row is live.',
    );
    return { enabled: false, skipped: true };
  }
}

/**
 * Best practice: verify whether the app is connected to GitHub so players know
 * GitHub can be their source of truth for files. Advisory only.
 */
export async function checkGitHubIntegration(game, { appId }, log = noop) {
  try {
    const status = await game?.crowdyStudioGitHub?.status?.({ appId });
    if (status?.connected && status?.owner && status?.repo) {
      const repo = `${status.owner}/${status.repo}`;
      log(`GitHub repository connected: ${repo}`);
      return { connected: true, skipped: false, repo };
    }
    log(
      'Advisory: No GitHub repository bound. In Crowdy Studio, bind a GitHub repository ' +
        'so GitHub serves as your source of truth for files.',
    );
    return { connected: false, skipped: true };
  } catch (err) {
    log(`GitHub integration check skipped (${messageOf(err)}).`);
    return { connected: false, skipped: true };
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The whole sequence. `enterApp(appId)` must return a client holding an
 * app-scoped token for `appId` (browser: NetworkManager.enterApp; Node: mint
 * and build a client). Returns a report the UI renders.
 */
export async function runOnboarding(options) {
  const {
    identity,
    userId,
    enterApp,
    orgName,
    appName,
    appSlug,
    datacenter,
    redirectOrigins = [],
    log = noop,
    onStep = noop,
  } = options;
  const report = { steps: [] };
  const step = async (id, label, fn) => {
    onStep({ id, label, status: 'running' });
    try {
      const value = await fn();
      report.steps.push({ id, label, status: 'done', value });
      onStep({ id, label, status: 'done', value });
      return value;
    } catch (error) {
      report.steps.push({ id, label, status: 'failed', error });
      onStep({ id, label, status: 'failed', error });
      throw error;
    }
  };

  const { org } = await step('org', 'Organization', () =>
    ensureOrganization(identity, { name: orgName, slug: orgName }, log),
  );
  const { app } = await step('app', 'App', () =>
    ensureApp(
      identity,
      {
        orgId: org.orgId,
        orgSlug: org.slug,
        name: appName,
        slug: appSlug ?? slugify(appName),
        datacenter,
      },
      log,
    ),
  );
  const appId = String(app.appId);
  await step('tier', 'Constructor access tier', () =>
    ensureConstructorTier(identity, { appId, userId }, log),
  );
  if (redirectOrigins.length > 0) {
    await step('redirects', 'Sign-in redirect URIs', () =>
      ensureRedirectUris(identity, { appId, origins: redirectOrigins }, log),
    );
  }
  const game = await step('enter', 'App token', () => enterApp(appId));
  await step('claims', 'Grid claim policy', () => ensureSelfClaimPolicy(game, { appId }, log));
  await step('model', 'Game model', () => deployModel(game, { appId }, log));
  await step('studio', 'Crowdy Studio starter files', () =>
    publishStarterFiles(game, { appId }, log),
  );
  await step('agent', 'Crowdy Agent policy', () => ensureAgentPolicy(identity, { appId }, log));
  await step('github', 'GitHub repository integration', () =>
    checkGitHubIntegration(game, { appId }, log),
  );
  report.org = org;
  report.app = app;
  report.appId = appId;
  return report;
}

function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

function noop() {}
