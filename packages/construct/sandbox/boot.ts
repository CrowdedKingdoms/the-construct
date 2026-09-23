/**
 * Runs INSIDE the JS grid program sandbox (`grid-program.html`, framed with
 * `sandbox="allow-scripts"`: an opaque origin with `connect-src 'none'`).
 *
 * The page sends one `init` message carrying the program's source and a
 * MessagePort. The program is loaded as a blob module and its default export
 * is called with real CrowdyJS whose network is that port (the page relays it
 * with a grid-scoped token the program never sees):
 *
 *   export default async function ({ client, grid, appId, gridId, box, log }) { … }
 *
 * Console output, errors and lifecycle are reported to the page, which shows
 * them to the player and to the Studio agent (`grid_program_status`).
 */
import { createGridProgramClient } from '@crowdedkingdoms/crowdyjs/grid-program';

import { GRID_PROGRAM_SOURCE, type GridProgramSandboxMessage } from '../src/grid/sandboxProtocol';

const post = (message: GridProgramSandboxMessage) =>
  window.parent.postMessage({ source: GRID_PROGRAM_SOURCE, ...message }, '*');

const format = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
};

for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    post({ type: 'log', level, line: args.map(format).join(' ').slice(0, 2_000) });
  };
}
window.addEventListener('error', (event) =>
  post({ type: 'error', message: String(event.message) }),
);
window.addEventListener('unhandledrejection', (event) =>
  post({ type: 'error', message: format((event as PromiseRejectionEvent).reason) }),
);

let started = false;
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || started) return;
  const data = event.data as { source?: string; type?: string; program?: string; path?: string };
  if (data?.source !== GRID_PROGRAM_SOURCE || data.type !== 'init') return;
  const port = event.ports[0];
  if (!port || typeof data.program !== 'string') return;
  started = true;
  void (async () => {
    const context = await createGridProgramClient(port);
    const url = URL.createObjectURL(new Blob([data.program!], { type: 'text/javascript' }));
    try {
      const module = (await import(/* @vite-ignore */ url)) as {
        default?: (ctx: unknown) => unknown;
      };
      if (typeof module.default !== 'function') {
        throw new Error('a grid program must `export default` a function');
      }
      post({ type: 'started' });
      await module.default({ ...context, log: (...args: unknown[]) => console.log(...args) });
    } catch (error) {
      post({ type: 'error', message: format(error) });
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
});

post({ type: 'ready' });
