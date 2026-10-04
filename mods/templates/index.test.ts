import { describe, expect, it } from 'vitest';

import { STARTER_TEMPLATES, commonFilesFor } from './index.mjs';

/** The sections and dependencies the platform's CLIENT build admits (execModClientBuild). */
const CLIENT_SECTIONS = new Set(['package', 'lib', 'package.metadata.crowdy', 'dependencies']);
const CLIENT_DEPENDENCIES = new Set(['crowdy-client-sdk', 'serde', 'serde_json']);
/** Identifiers the platform's source guard refuses anywhere in code. */
const HOST_READS =
  /\b(include|include_str|include_bytes|env|option_env|asm|global_asm|naked_asm)\b/;

function sections(manifest: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let section = '';
  for (const raw of manifest.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      out.set(section, new Map());
      continue;
    }
    const [key, value] = line.split(/\s*=\s*/, 2);
    out.get(section)?.set(key!, value!);
  }
  return out;
}

/** Rust with comments and string literals blanked, as the source guard reads it. */
function codeOnly(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const client = STARTER_TEMPLATES.filter((t) => t.target === 'CLIENT');

describe('CLIENT starter templates', () => {
  it('there are CLIENT starters', () => {
    expect(client.map((t) => t.id)).toEqual(['construct-hud-greeter', 'construct-voxel-marker']);
  });

  it.each(client)('$id is a crowdy-client-sdk crate the platform CLIENT build admits', (t) => {
    const cargo = t.files.find((f) => f.path === 'Cargo.toml')!.content;
    const parsed = sections(cargo);
    for (const name of parsed.keys()) expect(CLIENT_SECTIONS).toContain(name);
    expect(parsed.get('lib')?.get('crate-type')).toBe('["cdylib"]');
    const deps = [...(parsed.get('dependencies')?.keys() ?? [])];
    expect(deps).toContain('crowdy-client-sdk');
    for (const dep of deps) expect(CLIENT_DEPENDENCIES).toContain(dep);
    const tick = Number(parsed.get('package.metadata.crowdy')?.get('tick_interval_ms'));
    expect(tick).toBeGreaterThanOrEqual(16);
    expect(tick).toBeLessThanOrEqual(1000);
    expect(parsed.get('package')?.get('name')).toBe(`"${t.id}"`);
  });

  it.each(client)(
    '$id registers through crowdy-client-sdk and reads nothing of the build host',
    (t) => {
      expect(t.files.map((f) => f.path).sort()).toEqual(['Cargo.toml', 'src/lib.rs']);
      const lib = t.files.find((f) => f.path === 'src/lib.rs')!.content;
      expect(lib).toContain('use crowdy_client_sdk as crowdy;');
      expect(lib).toMatch(/crowdy::register_module!\(init: \w+, tick: \w+, invoke: \w+/);
      expect(lib).not.toMatch(/crowdy_compute_sdk|crowdy-compute-sdk/);
      expect(HOST_READS.exec(codeOnly(lib))).toBeNull();
    },
  );

  it('publishes each template as its entrypoint and its Cargo.toml', () => {
    for (const t of STARTER_TEMPLATES) {
      const files = commonFilesFor(t);
      expect(files.map((f) => f.path)).toEqual(['src/lib.rs', 'Cargo.toml']);
      expect(files.every((f) => f.target === t.target)).toBe(true);
    }
    const [, cargo] = commonFilesFor(client[0]!);
    expect(cargo!.description).toContain('crowdy-client-sdk');
  });
});
