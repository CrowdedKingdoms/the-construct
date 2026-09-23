import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Unit tests must not inherit `.env.local` (same-origin API, app id, Studio URL).
  envDir: path.resolve(rootDir, 'src'),
  resolve: {
    alias: { '@': path.resolve(rootDir, 'src') },
    // The framework package ships TypeScript source; resolve it from the
    // workspace so its tests and the starter's import the same files.
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'packages/construct/src/**/*.test.ts',
      'model/**/*.test.ts',
      'mods/**/*.test.ts',
    ],
    environment: 'happy-dom',
    // The SDK root barrel pulls Monaco; unit tests never need it and it does
    // not load under happy-dom. Tests mock the SDK surface they touch.
    server: { deps: { inline: [] } },
  },
});
