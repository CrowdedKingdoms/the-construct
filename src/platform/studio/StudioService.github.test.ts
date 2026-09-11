import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const studioService = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'StudioService.ts'),
  'utf8',
);

describe('StudioService GitHub SoT', () => {
  it('omits play-token crowdyStudioGitHub and embed github: (no identity session)', () => {
    expect(studioService).not.toMatch(/get crowdyStudioGitHub\s*\(/);
    expect(studioService).not.toMatch(/\bgithub:\s/);
    expect(studioService).toMatch(/Deliberately no `crowdyStudioGitHub`/);
  });
});
