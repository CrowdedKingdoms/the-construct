/**
 * The Construct's ck-exec code as a deploy takes it: the manifest (`exec/ckx.json`, whose types
 * name crates) and each crate's sources (its Cargo.toml and every .rs file under src/), which
 * `execBuild` compiles on the platform. Refuses while a generated source is stale, so a deploy
 * never ships a catalog that differs from `model/catalog.mjs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { staleFiles } from '../build-exec-sources.mjs';

const EXEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../exec');

function crateFiles(name) {
  const dir = path.join(EXEC, name);
  const files = { 'Cargo.toml': readFileSync(path.join(dir, 'Cargo.toml'), 'utf8') };
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.rs')) files[path.relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(path.join(dir, 'src'));
  return files;
}

export function execSources() {
  const stale = staleFiles();
  if (stale.length) throw new Error(`${stale.join(', ')} is stale: run npm run build:exec-sources`);
  const manifest = JSON.parse(readFileSync(path.join(EXEC, 'ckx.json'), 'utf8'));
  const names = [...new Set(Object.values(manifest.types).map((type) => type.crate))];
  return { manifest, crates: names.map((name) => ({ name, files: crateFiles(name) })) };
}
