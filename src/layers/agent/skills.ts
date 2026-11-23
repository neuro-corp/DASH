import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Project and global skills.
 *
 * A skill is `.dash/skills/<name>/SKILL.md` (project) or
 * `~/.dash/skills/<name>/SKILL.md` (global). Only the lightweight name and
 * description are placed in the prompt; full instructions are loaded on demand
 * through the `skill_loader` tool.
 */
export interface SkillSummary {
  name: string;
  description: string;
  source: 'project' | 'global';
  path: string;
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
}

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_DESCRIPTION = 200;
const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function skillRoots(workspaceRoot: string): Array<{ dir: string; source: SkillSummary['source'] }> {
  return [
    { dir: path.join(workspaceRoot, '.dash', 'skills'), source: 'project' },
    { dir: path.join(os.homedir(), '.dash', 'skills'), source: 'global' },
  ];
}

function readFrontmatter(text: string): { name?: string; description?: string; body: string } {
  if (!text.startsWith('---')) return { body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { body: text };
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const values: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]!.toLowerCase()] = match[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return {
    ...(values.name ? { name: values.name } : {}),
    ...(values.description ? { description: values.description } : {}),
    body,
  };
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const line = block.split(/\r?\n/).map(part => part.trim()).find(part => part && !part.startsWith('#'));
    if (line) return line;
  }
  return '';
}

function readSkillFile(filePath: string, fallbackName: string, source: SkillSummary['source']): LoadedSkill | undefined {
  let info: fs.Stats;
  try {
    info = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size > MAX_SKILL_BYTES) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = readFrontmatter(text);
  const name = (parsed.name || fallbackName).trim();
  if (!VALID_SKILL_NAME.test(name)) return undefined;
  const description = (parsed.description || firstParagraph(parsed.body) || 'No description provided.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION);
  return {
    name,
    description,
    source,
    path: filePath,
    instructions: parsed.body.trim() || text.trim(),
  };
}

/** Lightweight, deterministic skill list. Project skills shadow global ones. */
export function listSkills(workspaceRoot: string): SkillSummary[] {
  const found = new Map<string, SkillSummary>();
  for (const { dir, source } of skillRoots(workspaceRoot)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isDirectory() || !VALID_SKILL_NAME.test(entry.name)) continue;
      const filePath = path.resolve(dir, entry.name, SKILL_FILE);
      const relative = path.relative(dir, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const skill = readSkillFile(filePath, entry.name, source);
      if (!skill) continue;
      if (source === 'global' && found.has(skill.name)) continue;
      found.set(skill.name, {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
      });
    }
  }
  return [...found.values()].sort((a, b) =>
    a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'project' ? -1 : 1);
}

/** Load one skill by name. Paths are validated and never escape a skill root. */
export function loadSkill(workspaceRoot: string, requestedName: string): LoadedSkill | undefined {
  const name = requestedName.trim();
  if (!VALID_SKILL_NAME.test(name)) return undefined;
  for (const { dir, source } of skillRoots(workspaceRoot)) {
    const filePath = path.resolve(dir, name, SKILL_FILE);
    const relative = path.relative(dir, filePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const skill = readSkillFile(filePath, name, source);
    if (skill) return skill;
  }
  return undefined;
}

export function formatSkillCatalog(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return '';
  return skills
    .slice(0, 40)
    .map(skill => `- ${skill.name} (${skill.source}): ${skill.description}`)
    .join('\n');
}
