import type { CrowdyClient } from '@crowdedkingdoms/crowdyjs';

export const CONSTRUCTOR_TIER_NAME: string;
export const CONSTRUCTOR_TIER_KEYS: readonly string[];
export const VISITOR_RUN_KEYS: readonly string[];
export function slugify(value: string): string;

export type Logger = (line: string) => void;

export interface OnboardingStepEvent {
  id: 'org' | 'app' | 'tier' | 'enter' | 'claims' | 'model' | 'studio';
  label: string;
  status: 'running' | 'done' | 'failed';
  value?: unknown;
  error?: unknown;
}

export interface OnboardingReport {
  steps: OnboardingStepEvent[];
  org: { orgId: string; slug: string; name: string };
  app: { appId: string; name: string; slug: string };
  appId: string;
}

export interface RunOnboardingOptions {
  identity: CrowdyClient;
  userId: string;
  enterApp: (appId: string) => Promise<CrowdyClient>;
  orgName: string;
  appName: string;
  appSlug?: string;
  datacenter?: string;
  log?: Logger;
  onStep?: (event: OnboardingStepEvent) => void;
}

export function ensureOrganization(
  identity: CrowdyClient,
  input: { name: string; slug?: string },
  log?: Logger,
): Promise<{
  org: { orgId: string; slug: string; name: string };
  created: boolean;
  permissions: string[];
}>;
export function ensureApp(
  identity: CrowdyClient,
  input: { orgId: string; orgSlug: string; name: string; slug: string; datacenter?: string },
  log?: Logger,
): Promise<{ app: { appId: string; name: string; slug: string }; created: boolean }>;
export function ensureConstructorTier(
  identity: CrowdyClient,
  input: { appId: string; userId: string },
  log?: Logger,
): Promise<{
  tier: { tierId: string; name: string };
  created: boolean;
  updated: boolean;
  granted: boolean;
}>;
export function ensureSelfClaimPolicy(
  game: CrowdyClient,
  input: { appId: string },
  log?: Logger,
): Promise<{ policy: string; changed: boolean }>;
export function deployModel(
  game: CrowdyClient,
  input: { appId: string },
  log?: Logger,
): Promise<unknown>;
export function publishStarterFiles(
  game: CrowdyClient,
  input: { appId: string },
  log?: Logger,
): Promise<Array<{ slug: string; status: 'current' | 'published'; versionNo?: number }>>;
export function runOnboarding(options: RunOnboardingOptions): Promise<OnboardingReport>;
