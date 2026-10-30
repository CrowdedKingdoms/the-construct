import type { Plugin } from 'vite';

export function constructHeaderPlugins(options: {
  dshHeaders?: Record<string, string>;
  gridProgramHeaders?: Record<string, string>;
}): Plugin[];

/**
 * Crowdy Studio's hosted game-editor preview: the `virtual:construct-draft-host`
 * registry and the `construct-draft-sw.js` service worker.
 */
export function constructDraftPlugin(options?: {
  /** Game directories whose imports a draft may reuse (default `src`, `model`). */
  sourceRoots?: string[];
  /** More module specifiers a draft may import from the page. */
  extraModules?: string[];
}): Plugin;
