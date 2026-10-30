/**
 * The draft service worker: serves Crowdy Studio's game-editor draft as ES
 * modules, so a hosted game previews edits without a build and without
 * loosening its CSP (`script-src 'self'`: these are same-origin module URLs;
 * nothing is evaluated from a string or a blob).
 *
 * It controls the game's pages (its scope is the game's base) because a
 * service worker sees only the requests of the pages it controls, but it
 * answers nothing outside `BASE__draft/`: navigations, the harness, the API
 * and the game's own assets go to the network untouched. The page that
 * imports a draft module answers for it (`./draftLoader`): sources, the
 * generation's file list and the host's export names. A page that is not
 * running the game editor never answers, and its requests fail.
 *
 * Bundled as a classic script by `constructDraftPlugin` (node/vite-plugins).
 */
import type { PreviewError } from './content';
import {
  DraftTransformError,
  errorModuleSource,
  hostShimSource,
  parseDraftUrl,
  transformDraftModule,
  type DraftRequest,
} from './draftModules';

declare const self: ServiceWorkerGlobalScope;

const ANSWER_TIMEOUT_MS = 10_000;
const KEPT_GENERATIONS = 4;

type PageAnswer =
  | { ok: true; paths?: string[]; source?: string; names?: string[] }
  | { ok: false; message: string };

const base = new URL(self.registration.scope).pathname;
const manifests = new Map<string, Promise<Set<string>>>();

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const request = parseDraftUrl(url.pathname, base);
  if (!request) return;
  event.respondWith(answer(request, event.clientId));
});

async function ask(clientId: string, message: Record<string, unknown>): Promise<PageAnswer> {
  const client = clientId ? await self.clients.get(clientId) : undefined;
  if (!client) return { ok: false, message: 'No game page is waiting for this draft module.' };
  const channel = new MessageChannel();
  return new Promise<PageAnswer>((resolve) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve({
        ok: false,
        message: 'The page did not answer for the draft (is the game editor open?).',
      });
    }, ANSWER_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<PageAnswer>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    };
    client.postMessage({ type: 'construct-draft', ...message }, [channel.port2]);
  });
}

function manifestOf(clientId: string, generation: number): Promise<Set<string>> {
  const key = `${clientId}:${generation}`;
  let manifest = manifests.get(key);
  if (!manifest) {
    manifest = ask(clientId, { request: 'manifest', generation }).then((reply) => {
      if (!reply.ok || !reply.paths)
        throw new Error(reply.ok ? 'The page sent no file list.' : reply.message);
      return new Set(reply.paths);
    });
    manifest.catch(() => manifests.delete(key));
    manifests.set(key, manifest);
    while (manifests.size > KEPT_GENERATIONS)
      manifests.delete(manifests.keys().next().value as string);
  }
  return manifest;
}

function moduleResponse(code: string, status = 200): Response {
  return new Response(code, {
    status,
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** A module that throws, after telling the page what failed (it keeps the location). */
async function failure(
  clientId: string,
  error: PreviewError,
  generation?: number,
): Promise<Response> {
  const client = clientId ? await self.clients.get(clientId) : undefined;
  client?.postMessage({ type: 'construct-draft-error', generation, error });
  return moduleResponse(errorModuleSource(error));
}

async function answer(request: DraftRequest, clientId: string): Promise<Response> {
  try {
    switch (request.kind) {
      case 'module': {
        const paths = await manifestOf(clientId, request.generation);
        if (!paths.has(request.path)) {
          return failure(
            clientId,
            { path: request.path, message: `${request.path} is not in the draft.` },
            request.generation,
          );
        }
        const reply = await ask(clientId, {
          request: 'source',
          generation: request.generation,
          path: request.path,
        });
        if (!reply.ok || reply.source === undefined) {
          return failure(
            clientId,
            { path: request.path, message: reply.ok ? 'The page sent no source.' : reply.message },
            request.generation,
          );
        }
        const code = await transformDraftModule({
          source: reply.source,
          path: request.path,
          generation: request.generation,
          base,
          paths,
        });
        return moduleResponse(code);
      }
      case 'host': {
        const reply = await ask(clientId, { request: 'host', specifier: request.specifier });
        if (!reply.ok || !reply.names) {
          return failure(clientId, {
            message: reply.ok
              ? `The page sent no exports for ${request.specifier}.`
              : `${request.specifier}: ${reply.message}`,
          });
        }
        return moduleResponse(hostShimSource(request.specifier, reply.names));
      }
      case 'missing':
        return failure(clientId, {
          path: request.importer,
          message: `Cannot find "${request.specifier}" in the draft (imported by ${request.importer}).`,
        });
    }
  } catch (error) {
    if (error instanceof DraftTransformError) {
      return failure(
        clientId,
        error.error,
        request.kind === 'module' ? request.generation : undefined,
      );
    }
    return failure(clientId, { message: (error as Error).message ?? String(error) });
  }
}
