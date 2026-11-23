import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findIndexed,
  getIndexSummary,
  getIndexedFile,
  invalidateWorkspaceIndex,
  listIndexed,
  matchesWorkspaceGlob,
  refreshWorkspaceIndex,
  removeIndexedFile,
  searchIndexed,
  updateIndexedFile,
  workspaceIndexPath,
} from './workspace-index';

let workspaceRoot: string;
let dataDir: string;
let previousDataDir: string | undefined;

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(workspaceRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

beforeEach(async () => {
  previousDataDir = process.env.DASH_DATA_DIR;
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-index-root-'));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-index-data-'));
  process.env.DASH_DATA_DIR = dataDir;
  await write('src/a.ts', 'export const a = 1;\n');
  await write('lib/main.dart', 'void main() {}\n');
  await write('src/b.test.ts', 'test("b", () => {});\n');
  await write('README.md', '# readme\n');
  await write('node_modules/ignored.js', 'ignored\n');
  await write('ignored/secret.txt', 'secret\n');
  await write('.gitignore', 'ignored/\n');
});

afterEach(async () => {
  invalidateWorkspaceIndex(workspaceRoot);
  if (previousDataDir === undefined) delete process.env.DASH_DATA_DIR;
  else process.env.DASH_DATA_DIR = previousDataDir;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('workspace index', () => {
  it('indexes text files once, honors ignores, and summarizes the workspace', async () => {
    const { index, changes } = refreshWorkspaceIndex(workspaceRoot);
    const paths = index.files.map(file => file.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('lib/main.dart');
    expect(paths).toContain('src/b.test.ts');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('node_modules/ignored.js');
    expect(paths).not.toContain('ignored/secret.txt');
    expect(changes.added).toContain('src/a.ts');
    expect(await fs.stat(workspaceIndexPath(workspaceRoot))).toBeDefined();

    const summary = getIndexSummary(workspaceRoot);
    expect(summary.fileCount).toBe(5);
    expect(summary.languages.TypeScript).toBe(2);
    expect(summary.languages.Dart).toBe(1);
    expect(summary.categories.test).toBe(1);
    expect(summary.keyFiles).toContain('README.md');
  });

  it('paginates directory listings and glob matches', async () => {
    refreshWorkspaceIndex(workspaceRoot);
    const first = listIndexed(workspaceRoot, 'src', false, undefined, 0, 1);
    expect(first.total).toBe(2);
    expect(first.entries).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    const second = listIndexed(workspaceRoot, 'src', false, undefined, first.nextOffset ?? 0, 1);
    expect(second.entries).toHaveLength(1);
    expect(second.nextOffset).toBeNull();

    const matches = findIndexed(workspaceRoot, '*.ts', 0, 1);
    expect(matches.total).toBe(2);
    expect(matches.files).toHaveLength(1);
    expect(matches.nextOffset).toBe(1);
    expect(matchesWorkspaceGlob('src/a.ts', '**/*.ts')).toBe(true);
    expect(matchesWorkspaceGlob('src/a.ts', '*.ts')).toBe(true);
  });

  it('searches indexed file contents with a resumable cursor', async () => {
    await write('matches.txt', 'needle one\nnothing\nneedle two\nneedle three\n');
    refreshWorkspaceIndex(workspaceRoot);

    const first = await searchIndexed(workspaceRoot, 'needle', { limit: 2 });
    expect(first.matches.map(match => match.line)).toEqual([1, 3]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe('matches.txt:3');

    const second = await searchIndexed(workspaceRoot, 'needle', { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.matches.map(match => match.line)).toEqual([4]);
    expect(second.truncated).toBe(false);

    const regex = await searchIndexed(workspaceRoot, '^needle two$', { regex: true });
    expect(regex.matches.map(match => match.path)).toContain('matches.txt');
  });

  it('applies gitignore negations and reports refresh changes', async () => {
    await write('.gitignore', '*.log\n!keep.log\n');
    await write('debug.log', 'drop\n');
    await write('keep.log', 'keep\n');
    const first = refreshWorkspaceIndex(workspaceRoot);
    expect(first.index.files.map(file => file.path)).toContain('keep.log');
    expect(first.index.files.map(file => file.path)).not.toContain('debug.log');

    await write('src/new.ts', 'export const n = 1;\n');
    const second = refreshWorkspaceIndex(workspaceRoot);
    expect(second.changes.added).toContain('src/new.ts');
  });

  it('updates and removes individual entries without a full rescan', async () => {
    refreshWorkspaceIndex(workspaceRoot);
    await write('src/c.ts', 'export const c = 3;\n');
    const updated = updateIndexedFile(workspaceRoot, 'src/c.ts', { lineCount: 1 });
    expect(updated?.path).toBe('src/c.ts');
    expect(getIndexedFile(workspaceRoot, 'src/c.ts')?.lineCount).toBe(1);

    removeIndexedFile(workspaceRoot, 'src/c.ts');
    expect(getIndexedFile(workspaceRoot, 'src/c.ts')).toBeUndefined();
  });
});
