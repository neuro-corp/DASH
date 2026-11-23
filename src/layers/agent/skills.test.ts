import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatSkillCatalog, listSkills, loadSkill, skillRoots } from './skills';

let workspaceRoot: string;
let homeDir: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

async function writeSkill(root: string, name: string, text: string): Promise<void> {
  const directory = path.join(root, '.dash', 'skills', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), text, 'utf8');
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-skills-'));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-skills-home-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('agent skills', () => {
  it('lists project skills with lightweight metadata', async () => {
    await writeSkill(workspaceRoot, 'deploy', [
      '---',
      'name: deploy',
      'description: Deploy the service safely.',
      '---',
      '',
      '# Deploy',
      '',
      'Run the deployment checklist.',
    ].join('\n'));
    await writeSkill(workspaceRoot, 'testing', [
      '# Testing',
      '',
      'Run focused tests before a full suite.',
    ].join('\n'));

    const skills = listSkills(workspaceRoot);
    expect(skills.map(skill => skill.name).sort()).toEqual(['deploy', 'testing']);
    const deploy = skills.find(skill => skill.name === 'deploy');
    expect(deploy?.description).toBe('Deploy the service safely.');
    expect(deploy?.source).toBe('project');
    expect(deploy?.path.endsWith(path.join('deploy', 'SKILL.md'))).toBe(true);
    const testing = skills.find(skill => skill.name === 'testing');
    expect(testing?.description).toBe('Run focused tests before a full suite.');

    const catalog = formatSkillCatalog(skills);
    expect(catalog).toContain('- deploy (project): Deploy the service safely.');
    expect(catalog).toContain('- testing (project):');
  });

  it('loads full instructions on demand and treats them as untrusted text', async () => {
    await writeSkill(workspaceRoot, 'deploy', [
      '---',
      'name: deploy',
      'description: Deploy the service safely.',
      '---',
      '',
      'Step one: run checks.',
      'Step two: deploy.',
    ].join('\n'));

    const loaded = loadSkill(workspaceRoot, 'deploy');
    expect(loaded?.instructions).toContain('Step one: run checks.');
    expect(loaded?.instructions).not.toContain('description:');
    expect(formatSkillCatalog(listSkills(workspaceRoot))).not.toContain('Step one');
  });

  it('rejects missing, oversized, and path-traversal skill requests', async () => {
    expect(loadSkill(workspaceRoot, 'missing')).toBeUndefined();
    expect(loadSkill(workspaceRoot, '../deploy')).toBeUndefined();
    expect(loadSkill(workspaceRoot, '..\\deploy')).toBeUndefined();
    expect(loadSkill(workspaceRoot, 'deploy/../../etc')).toBeUndefined();

    const huge = 'x'.repeat(128 * 1024 + 1);
    await writeSkill(workspaceRoot, 'huge', huge);
    expect(listSkills(workspaceRoot).some(skill => skill.name === 'huge')).toBe(false);
  });

  it('exposes project and global skill roots', () => {
    const roots = skillRoots(workspaceRoot);
    expect(roots[0]).toEqual({ dir: path.join(workspaceRoot, '.dash', 'skills'), source: 'project' });
    expect(roots[1]?.source).toBe('global');
  });
});
