import type { Plugin } from 'vite';

export function constructHeaderPlugins(options: {
  dshHeaders: Record<string, string>;
  gridProgramHeaders?: Record<string, string>;
}): Plugin[];
