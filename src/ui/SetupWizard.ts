/**
 * Setup: turn a signed-in account into a playable, moddable app.
 *
 * Two doors: create (org -> app -> Constructor tier -> claim policy -> model
 * -> Studio starter files, all idempotent) or pick an app the account already
 * has. Either way the result is an app id the boot flow enters and remembers
 * for this browser. Re-running Setup on an existing app is how you deploy
 * model or template changes.
 */
import type { CrowdyClient } from '@crowdedkingdoms/crowdyjs';

import { runOnboarding, slugify, type OnboardingStepEvent } from '@/platform/onboarding/steps.mjs';
import type { NetworkManager } from '@/platform/network/NetworkManager';
import type { BootCard } from '@/ui/BootCard';
import { el, messageOf } from '@/ui/dom';

export interface SetupResult {
  appId: string;
}

interface SetupOptions {
  /** Pre-fill and explain why Setup opened (e.g. the pinned app failed). */
  reason?: string;
  /** The app currently remembered, if any, so "Re-run on this app" works. */
  currentAppId?: string | null;
}

const STEP_LABELS: Array<{ id: OnboardingStepEvent['id']; label: string }> = [
  { id: 'org', label: 'Organization' },
  { id: 'app', label: 'App (free, shared hosting)' },
  { id: 'tier', label: 'Constructor access tier with code keys' },
  { id: 'enter', label: 'Mint an app token' },
  { id: 'claims', label: 'Grid claim policy: self-claim' },
  { id: 'model', label: 'Deploy the game model' },
  { id: 'studio', label: 'Publish Crowdy Studio starter files' },
];

export function showSetupWizard(
  card: BootCard,
  network: NetworkManager,
  options: SetupOptions = {},
): Promise<SetupResult> {
  return new Promise((resolve) => {
    const user = network.user;
    const defaultOrg = user?.gamertag ? `${user.gamertag}'s studio` : 'My studio';
    const orgName = el('input', { type: 'text', placeholder: defaultOrg });
    orgName.value = defaultOrg;
    const appName = el('input', { type: 'text', placeholder: 'The Construct' });
    appName.value = 'The Construct';
    const appSlug = el('input', { type: 'text', placeholder: 'the-construct' });
    appSlug.value = 'the-construct';
    appName.addEventListener('input', () => (appSlug.value = slugify(appName.value)));

    const existing = el('select');
    existing.appendChild(el('option', { value: '', text: 'Loading your apps…' }));
    const manualId = el('input', {
      type: 'text',
      inputmode: 'numeric',
      placeholder: 'or paste an app id',
    });
    if (options.currentAppId) manualId.value = options.currentAppId;

    const error = el('p', { class: 'error-text' });
    const steps = el('ul', { class: 'steps hidden' });
    const log = el('pre', { class: 'log mono hidden' });
    const create = el('button', { class: 'primary', type: 'button', text: 'Create my app' });
    const useExisting = el('button', { type: 'button', text: 'Use this app' });
    const rerun = el('button', { type: 'button', text: 'Re-run setup on this app' });

    const stepItems = new Map<string, HTMLElement>();
    for (const step of STEP_LABELS) {
      const item = el('li', { 'data-status': 'pending' }, [
        el('span', { class: 'dot' }),
        el('span', { text: step.label }),
      ]);
      stepItems.set(step.id, item);
      steps.appendChild(item);
    }

    const appendLog = (line: string) => {
      log.classList.remove('hidden');
      log.textContent += `${line}\n`;
      log.scrollTop = log.scrollHeight;
    };
    const busy = (on: boolean) => {
      create.disabled = on;
      useExisting.disabled = on;
      rerun.disabled = on;
    };

    const enterApp = async (appId: string): Promise<CrowdyClient> => {
      await network.enterApp(appId);
      return network.game;
    };

    const run = async (values: { orgName: string; appName: string; appSlug: string }) => {
      busy(true);
      error.textContent = '';
      steps.classList.remove('hidden');
      for (const item of stepItems.values()) item.dataset.status = 'pending';
      try {
        const report = await runOnboarding({
          identity: network.identity,
          userId: user?.userId ?? '',
          enterApp,
          orgName: values.orgName,
          appName: values.appName,
          appSlug: values.appSlug,
          log: appendLog,
          onStep: (event) => {
            const item = stepItems.get(event.id);
            if (item) item.dataset.status = event.status;
          },
        });
        card.setStatus(`App ${report.appId} is ready`);
        appendLog(
          `Done. App id ${report.appId}. Add VITE_APP_ID=${report.appId} to .env.local to pin it.`,
        );
        const play = el('button', {
          class: 'primary',
          type: 'button',
          text: 'Enter The Construct',
        });
        play.addEventListener('click', () => resolve({ appId: report.appId }));
        actions.replaceChildren(play);
      } catch (err) {
        error.textContent = friendlySetupError(err);
        busy(false);
      }
    };

    create.addEventListener('click', () =>
      run({
        orgName: orgName.value.trim() || defaultOrg,
        appName: appName.value.trim() || 'The Construct',
        appSlug: slugify(appSlug.value.trim() || appName.value || 'the-construct'),
      }),
    );
    useExisting.addEventListener('click', () => {
      const appId = (manualId.value.trim() || existing.value).trim();
      if (!/^\d+$/.test(appId)) {
        error.textContent = 'Pick an app from the list or paste a numeric app id.';
        return;
      }
      resolve({ appId });
    });
    rerun.addEventListener('click', async () => {
      const appId = (manualId.value.trim() || existing.value).trim();
      if (!/^\d+$/.test(appId)) {
        error.textContent = 'Pick the app to re-run setup on.';
        return;
      }
      // Re-running reuses the app's own org/slug: look them up, then run the
      // same idempotent sequence, which finds rather than creates.
      busy(true);
      try {
        const app = await network.identity.apps.app(appId);
        if (!app) throw new Error(`App ${appId} not found or not visible to you`);
        const orgs = await network.identity.organizations.mine();
        const org = orgs.find((o) => String(o.org.orgId) === String(app.orgId));
        await run({
          orgName: org?.org.name ?? defaultOrg,
          appName: app.name,
          appSlug: app.slug ?? slugify(app.name),
        });
      } catch (err) {
        error.textContent = messageOf(err);
        busy(false);
      }
    });

    const actions = el('div', { class: 'actions' }, [create]);
    const existingActions = el('div', { class: 'actions' }, [useExisting, rerun]);

    card.setStatus(options.reason ?? 'One-time setup: your own org and app on Crowded Kingdoms');
    card.show([
      el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 4px' }, [
        'No card needed. A new org gets free shared-hosting apps with monthly allowances; ',
        'everything below is idempotent and safe to re-run.',
      ]),
      el('label', { text: 'Organization name' }),
      orgName,
      el('label', { text: 'App name' }),
      appName,
      el('label', { text: 'App slug' }),
      appSlug,
      actions,
      el('hr', { style: 'border:0;border-top:1px solid rgba(255,255,255,0.08);margin:18px 0 6px' }),
      el('label', { text: 'Already have an app?' }),
      existing,
      el('div', { style: 'height:6px' }),
      manualId,
      existingActions,
      error,
      steps,
      log,
    ]);

    void network.identity.apps
      .myApps()
      .then((apps) => {
        existing.replaceChildren(
          el('option', { value: '', text: apps.length ? 'Choose an app…' : 'No apps yet' }),
        );
        for (const app of apps) {
          existing.appendChild(
            el('option', { value: String(app.appId), text: `${app.name} (${app.appId})` }),
          );
        }
        if (options.currentAppId) existing.value = options.currentAppId;
      })
      .catch((err) => {
        existing.replaceChildren(
          el('option', { value: '', text: `Could not list apps: ${messageOf(err)}` }),
        );
      });
  });
}

function friendlySetupError(error: unknown): string {
  const text = messageOf(error);
  if (/slug/i.test(text) && /exist|taken|unique|duplicate/i.test(text)) {
    return `${text}\nPick another slug, or use "Already have an app?" below.`;
  }
  if (/FORBIDDEN|SCOPE_MISSING|manage_apps|manage_access_tiers/i.test(text)) {
    return `${text}\nYour account lacks an admin permission on this org. Use an org you own, or create a new one.`;
  }
  return text;
}
