import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildProjectKnowledge, compactProjectKnowledge } from './project-knowledge';

let workspaceRoot: string;

async function write(relativePath: string, content: string): Promise<void> {
  const target = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-project-knowledge-'));
  await write('package.json', JSON.stringify({
    name: 'demo-project',
    version: '1.2.3',
    scripts: { test: 'bun test', typecheck: 'tsc --noEmit' },
    devDependencies: { typescript: '^5.0.0' },
  }, null, 2));
  await write('bun.lock', '');
  await write('README.md', '# Demo project\n\nA small service that coordinates widget imports and exports.\n\n## Usage\n\nRun the tests.\n');
  await write('AGENTS.md', '# Agent guidance\n\n- Keep changes focused.\n- Run tests after editing.\n');
  await write('src/index.ts', 'export function main() { return "ok"; }\n');
  await write('src/widgets/store.ts', 'export const widgets = [];\n');
  await write('tests/widget.test.ts', 'import { expect, test } from "bun:test";\n');
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('project knowledge', () => {
  it('builds source-attributed project knowledge from existing metadata and documents', () => {
    const knowledge = buildProjectKnowledge(workspaceRoot);
    expect(knowledge.packageName).toBe('demo-project');
    expect(knowledge.ecosystem).toBe('bun');
    expect(knowledge.packageManager).toBe('bun');
    expect(knowledge.purpose).toContain('widget imports');
    expect(knowledge.purposeSource).toBe('README.md');
    expect(knowledge.documents.map(document => document.path)).toContain('README.md');
    expect(knowledge.documents.map(document => document.path)).toContain('AGENTS.md');
    expect(knowledge.commands.some(command => command.kind === 'test' && command.command === 'bun run test')).toBe(true);
    expect(knowledge.layout.sourceDirs).toContain('src');
    expect(knowledge.layout.entryPoints).toContain('src/index.ts');
    expect(knowledge.modules.find(module => module.path === 'src')?.role).toBe('source code');
    expect(knowledge.modules.find(module => module.path === 'tests')?.role).toBe('tests');
    expect(knowledge.conventions.some(convention => convention.source === 'AGENTS.md')).toBe(true);
    expect(knowledge.sources.some(source => source.path === 'workspace-index')).toBe(true);
    expect(knowledge.sources.some(source => source.path === 'README.md' && Boolean(source.hash))).toBe(true);
    expect(knowledge.freshness.fileCount).toBeGreaterThan(0);
    expect(knowledge.freshness.indexStale).toBe(false);
  });

  it('keeps excerpts bounded and reports document changes with fresh hashes', async () => {
    const before = buildProjectKnowledge(workspaceRoot);
    const readmeBefore = before.documents.find(document => document.path === 'README.md');
    expect(readmeBefore).toBeDefined();
    expect(before.documents.reduce((sum, document) => sum + document.excerpt.length, 0)).toBeLessThanOrEqual(2_400);

    await write('README.md', '# Demo project\n\nUpdated purpose describing a completely different scheduler service.\n');
    const after = buildProjectKnowledge(workspaceRoot);
    const readmeAfter = after.documents.find(document => document.path === 'README.md');
    expect(after.purpose).toContain('scheduler service');
    expect(readmeAfter?.hash).not.toBe(readmeBefore?.hash);
    expect(readmeAfter?.mtimeMs).toBeGreaterThanOrEqual(readmeBefore?.mtimeMs ?? 0);
  });

  it('provides a compact runtime view without document excerpts', () => {
    const knowledge = buildProjectKnowledge(workspaceRoot);
    const compact = compactProjectKnowledge(knowledge);
    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain('Run the tests.');
    expect(serialized).not.toContain('Keep changes focused.');
    expect(serialized).toContain('demo-project');
    expect(serialized).toContain('README.md');
    expect(compact.freshness).toBeDefined();
  });
});
