import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectProject, getProjectMap, getProjectScripts, invalidateProjectCache } from './project';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-project-'));
  invalidateProjectCache();
});

afterEach(async () => {
  invalidateProjectCache();
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('project intelligence', () => {
  it('detects npm with package-lock and discovered verification scripts', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'sample-node',
      version: '1.2.3',
      scripts: { lint: 'eslint .', test: 'jest', build: 'webpack', start: 'node server.js' },
      devDependencies: { jest: '^29', eslint: '^8' },
      dependencies: { express: '^4' },
    }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'package-lock.json'), '{}', 'utf8');
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'index.js'), 'const x = 1;', 'utf8');

    const info = inspectProject(projectRoot);
    expect(info.ecosystem).toBe('node');
    expect(info.packageManager).toBe('npm');
    expect(info.frameworks).toContain('Express');
    expect(info.scripts.test).toBe('jest');
    expect(info.verifyCommands.map(command => command.command)).toContain('npm run lint');
    expect(info.verifyCommands.map(command => command.command)).toContain('npm run test');
    expect(info.sourceDirs).toContain('src');
    expect(info.entryPoints).toContain('src/index.js');
  });

  it('detects bun via lockfile and falls back to bunx tsc for typecheck when no script exists', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'sample-bun',
      scripts: {},
      devDependencies: { typescript: '^5', '@types/bun': 'latest' },
    }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'bun.lock'), '', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'tsconfig.json'), '{}', 'utf8');

    const info = inspectProject(projectRoot);
    expect(info.ecosystem).toBe('bun');
    expect(info.packageManager).toBe('bun');
    const typecheck = info.verifyCommands.find(command => command.kind === 'typecheck');
    expect(typecheck?.command).toContain('tsc --noEmit');
    const test = info.verifyCommands.find(command => command.kind === 'test');
    expect(test?.command).toBe('bun test');
  });

  it('does not fall back to npm for a pnpm workspace', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'vitest run' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'pnpm-lock.yaml'), '', 'utf8');
    const info = inspectProject(projectRoot);
    expect(info.packageManager).toBe('pnpm');
    expect(info.verifyCommands.map(command => command.command)).toContain('pnpm run test');
  });

  it('marks missing checks as skipped rather than pretending commands exist', async () => {
    const info = inspectProject(projectRoot);
    expect(info.ecosystem).toBe('unknown');
    expect(info.verifyCommands).toEqual([]);
  });

  it('detects python projects via pyproject', async () => {
    await fs.writeFile(path.join(projectRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf8');
    const info = inspectProject(projectRoot);
    expect(info.ecosystem).toBe('python');
    expect(info.verifyCommands.some(command => command.kind === 'test' && command.command.includes('pytest'))).toBe(true);
  });

  it('detects rust and go projects', async () => {
    await fs.writeFile(path.join(projectRoot, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    expect(inspectProject(projectRoot).ecosystem).toBe('rust');
    await fs.rm(path.join(projectRoot, 'Cargo.toml'));
    await fs.writeFile(path.join(projectRoot, 'go.mod'), 'module x\n', 'utf8');
    expect(inspectProject(projectRoot).ecosystem).toBe('go');
  });

  it('detects Flutter projects and their standard verification commands', async () => {
    await fs.writeFile(path.join(projectRoot, 'pubspec.yaml'), [
      'name: sample_flutter',
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
      'dev_dependencies:',
      '  flutter_test:',
      '    sdk: flutter',
    ].join('\n'), 'utf8');
    await fs.mkdir(path.join(projectRoot, 'lib'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'lib', 'main.dart'), 'void main() {}\n', 'utf8');

    const info = inspectProject(projectRoot);
    expect(info.ecosystem).toBe('flutter');
    expect(info.frameworks).toContain('Flutter');
    expect(info.languages).toContain('Dart');
    expect(info.entryPoints).toContain('lib/main.dart');
    expect(info.verifyCommands.map(command => command.command)).toEqual(['flutter analyze', 'flutter test']);
  });

  it('detects a Dart package without mislabeling it as Flutter', async () => {
    await fs.writeFile(path.join(projectRoot, 'pubspec.yaml'), 'name: sample_dart\ndependencies:\n  path: ^1.9.0\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, 'test'), { recursive: true });

    const info = inspectProject(projectRoot);
    expect(info.ecosystem).toBe('dart');
    expect(info.frameworks).not.toContain('Flutter');
    expect(info.verifyCommands.map(command => command.command)).toEqual(['dart analyze', 'dart test']);
  });

  it('invalidates cached project info when the manifest changes', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'before', scripts: {} }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'bun.lock'), '', 'utf8');
    const before = inspectProject(projectRoot);
    expect(before.scripts).toEqual({});
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'after', scripts: { test: 'jest' } }), 'utf8');
    await fs.utimes(path.join(projectRoot, 'bun.lock'), new Date(), new Date());
    const after = inspectProject(projectRoot);
    expect(after.scripts.test).toBe('jest');
  });

  it('builds a compact project map', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'm', scripts: {} }), 'utf8');
    await fs.mkdir(path.join(projectRoot, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'deep', 'a.ts'), 'x', 'utf8');
    const map = getProjectMap(projectRoot);
    expect(map.ecosystem).toBe('node');
    expect(map.keyFiles.some(file => file.includes('package.json'))).toBe(true);
    expect(map.sourceSummary.some(entry => entry.startsWith('src/'))).toBe(true);
  });

  it('exposes project scripts through getProjectScripts', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 's', scripts: { lint: 'eslint .' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'package-lock.json'), '{}', 'utf8');
    const scripts = getProjectScripts(projectRoot);
    expect(scripts.packageManager).toBe('npm');
    expect(scripts.runnerBase).toBe('npm run');
    expect(scripts.scripts.lint).toBe('eslint .');
  });
});
