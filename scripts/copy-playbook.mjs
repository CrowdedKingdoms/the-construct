#!/usr/bin/env node
/**
 * Copy a Studio playbook into public/playbook/ so Crowdy Studio's game editor
 * can read it same-origin: its pages (`read_playbook`) and the skills it
 * lists for the dock (`skills/index.json`, which the page serves as
 * `studio.listSkills`). Optional: without CONSTRUCT_PLAYBOOK_DIR nothing is
 * copied, and the dock has the game's STUDIO.md and no skills.
 *
 *   CONSTRUCT_PLAYBOOK_DIR=/path/to/a/playbook/checkout   (playbook/, .agents/skills/, README.md)
 *
 * public/playbook/ is gitignored and rewritten before every dev and build. A
 * skill reaches the dock only when its SKILL.md frontmatter says so:
 *
 *   metadata:
 *     surface: dock
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `name`, `description` and `metadata.surface` of a SKILL.md, or null
 * without frontmatter. One-line values only, as the playbooks write them.
 */
export function skillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ''));
  if (!match) return null;
  const top = {};
  const metadata = {};
  let inMetadata = false;
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (inMetadata && nested) {
      metadata[nested[1]] = unquote(nested[2]);
      continue;
    }
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    inMetadata = field[1] === 'metadata' && field[2].trim() === '';
    if (!inMetadata) top[field[1]] = unquote(field[2]);
  }
  return { name: top.name, description: top.description, surface: metadata.surface };
}

function unquote(value) {
  const trimmed = String(value ?? '').trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function markdownUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

function copyMarkdown(fromDir, toDir) {
  for (const file of markdownUnder(fromDir)) {
    const rel = path.relative(fromDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(toDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(file, dest);
  }
}

/** The dock's skill index for the skills under `skillsDir`, paths relative to the playbook root. */
export function dockSkillIndex(skillsDir) {
  const skills = [];
  if (!existsSync(skillsDir)) return { skills };
  for (const name of readdirSync(skillsDir).sort()) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const front = skillFrontmatter(readFileSync(file, 'utf8'));
    if (!front || front.surface !== 'dock' || !front.name || !front.description) continue;
    skills.push({
      name: front.name,
      description: front.description,
      page: `skills/${name}/SKILL.md`,
    });
  }
  return { skills };
}

/** Copy the playbook at `source` into `target`; returns what was written. */
export function copyPlaybook(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  copyMarkdown(path.join(source, 'playbook'), path.join(target, 'playbook'));
  copyMarkdown(path.join(source, '.agents', 'skills'), path.join(target, 'skills'));
  const readme = path.join(source, 'README.md');
  if (existsSync(readme)) cpSync(readme, path.join(target, 'README.md'));
  const index = dockSkillIndex(path.join(source, '.agents', 'skills'));
  mkdirSync(path.join(target, 'skills'), { recursive: true });
  writeFileSync(path.join(target, 'skills', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(process.env.CONSTRUCT_APP_ROOT ?? process.cwd());
  const target = path.join(appRoot, 'public', 'playbook');
  const source = process.env.CONSTRUCT_PLAYBOOK_DIR?.trim();
  if (!source) {
    console.log(
      'copy-playbook: CONSTRUCT_PLAYBOOK_DIR is not set; the dock has no playbook skills.',
    );
    process.exit(0);
  }
  if (
    !existsSync(path.join(source, 'playbook')) &&
    !existsSync(path.join(source, '.agents', 'skills'))
  ) {
    console.log(
      `copy-playbook: ${source} has no playbook/ or .agents/skills/; public/playbook was not written.`,
    );
    process.exit(0);
  }
  const index = copyPlaybook(path.resolve(source), target);
  console.log(`copy-playbook: public/playbook <- ${source} (${index.skills.length} dock skill(s))`);
}
