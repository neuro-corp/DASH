import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIndexSummary } from './workspace-index';

export type Ecosystem = 'node' | 'bun' | 'python' | 'rust' | 'go' | 'php' | 'ruby' | 'dart' | 'flutter' | 'unknown';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface VerifyCommand {
  kind: 'lint' | 'typecheck' | 'test' | 'build';
  command: string;
  source: 'script' | 'synthetic';
  note?: string;
}

export interface ProjectInfo {
  root: string;
  relativeRoot: string;
  ecosystem: Ecosystem;
  packageManager?: PackageManager;
  runnerBase: string;
  packageName?: string;
  version?: string;
  frameworks: string[];
  languages: string[];
  scripts: Record<string, string>;
  lockfiles: string[];
  manifests: string[];
  hasTypeScript: boolean;
  sourceDirs: string[];
  entryPoints: string[];
  lintConfigFiles: string[];
  testConfigFiles: string[];
  verifyCommands: VerifyCommand[];
  docFiles: string[];
}

interface CacheEntry {
  stamp: string;
  info: ProjectInfo;
}

const cache = new Map<string, CacheEntry>();

const topLevelDirsIgnored = new Set<string>([
  '.git', 'node_modules', '.dash', 'dist', 'build', 'out', 'coverage', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'vendor',
]);

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* Manifest is malformed; discovery continues without it. */ }
  return undefined;
}

function readTextFileCapped(filePath: string, maxBytes = 64 * 1024): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function detectPackageManager(root: string, scripts: Record<string, string>): PackageManager | undefined {
  const managerByLock: Array<[string, PackageManager]> = [
    ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  for (const [lockfile, manager] of managerByLock) {
    if (fileExists(path.join(root, lockfile))) return manager;
  }
  if (typeof scripts.bun === 'string') return 'bun';
  return fileExists(path.join(root, 'package.json')) ? 'npm' : undefined;
}

const NODE_FRAMEWORK_HINTS: Array<[string, string]> = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['react', 'React'], ['react-dom', 'React'],
  ['vue', 'Vue'], ['svelte', 'Svelte'], ['astro', 'Astro'], ['vite', 'Vite'], ['esbuild', 'esbuild'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['electron', 'Electron'],
  ['typescript', 'TypeScript'], ['jest', 'Jest'], ['vitest', 'Vitest'], ['@playwright/test', 'Playwright'],
  ['bun', 'Bun'], ['ink', 'Ink'], ['tailwindcss', 'Tailwind CSS'],
];

const PYTHON_FRAMEWORK_HINTS: Array<[RegExp, string]> = [
  [/django/i, 'Django'], [/\bflask\b/i, 'Flask'], [/fastapi/i, 'FastAPI'], [/pytest/i, 'pytest'],
  [/mypy/i, 'mypy'], [/\bruff\b/i, 'ruff'], [/poetry/i, 'Poetry'], [/\bcelery\b/i, 'Celery'],
];

function deriveRunner(ecosystem: Ecosystem, manager: PackageManager | undefined): string {
  switch (ecosystem) {
    case 'flutter': return 'flutter';
    case 'dart': return 'dart';
    case 'bun': return 'bun run';
    case 'node':
      if (!manager || manager === 'npm') return 'npm run';
      return `${manager} run`;
    case 'python': return 'python -m';
    default: return 'npm run';
  }
}

function buildVerifyCommands(root: string, ecosystem: Ecosystem, runnerBase: string, scripts: Record<string, string>, hasTypeScript: boolean, manager: PackageManager | undefined): VerifyCommand[] {
  const commands: VerifyCommand[] = [];
  if (ecosystem === 'flutter') {
    commands.push({ kind: 'lint', command: 'flutter analyze', source: 'synthetic' });
    commands.push({ kind: 'test', command: 'flutter test', source: 'synthetic' });
  } else if (ecosystem === 'dart') {
    commands.push({ kind: 'lint', command: 'dart analyze', source: 'synthetic' });
    if (fs.existsSync(path.join(root, 'test'))) {
      commands.push({ kind: 'test', command: 'dart test', source: 'synthetic' });
    }
  } else if (ecosystem === 'node' || ecosystem === 'bun') {
    const run = (script: string): string => `${runnerBase} ${script}`;
    if (typeof scripts.lint === 'string') commands.push({ kind: 'lint', command: run('lint'), source: 'script' });
    if (typeof scripts.typecheck === 'string') commands.push({ kind: 'typecheck', command: run('typecheck'), source: 'script' });
    else if (typeof scripts.check === 'string') commands.push({ kind: 'typecheck', command: run('check'), source: 'script' });
    else if (hasTypeScript) commands.push({ kind: 'typecheck', command: `${manager === 'bun' ? 'bunx' : 'npx'} tsc --noEmit`, source: 'synthetic', note: 'Fallback typecheck (no script found).' });
    if (typeof scripts.test === 'string') commands.push({ kind: 'test', command: run('test'), source: 'script' });
    else if (fileExists(path.join(root, 'bun.lock')) || filesExistAny(root, ['bunfig.toml'])) commands.push({ kind: 'test', command: 'bun test', source: 'synthetic', note: 'Fallback Bun test runner.' });
    else if (fileExists(path.join(root, 'node_modules', '.bin', 'jest' + (process.platform === 'win32' ? '.cmd' : '')))) commands.push({ kind: 'test', command: 'npx jest --passWithNoTests', source: 'synthetic', note: 'Fallback Jest runner.' });
    if (typeof scripts.build === 'string') commands.push({ kind: 'build', command: run('build'), source: 'script' });
  } else if (ecosystem === 'python') {
    if (fileExists(path.join(root, 'pyproject.toml')) || fileExists(path.join(root, 'setup.cfg')) || fileExists(path.join(root, '.ruff.toml'))) {
      commands.push({ kind: 'lint', command: 'python -m ruff check .', source: 'synthetic', note: 'Uses ruff when configured.' });
    }
    commands.push({ kind: 'test', command: 'python -m pytest -x -q', source: 'synthetic', note: 'Fallback pytest invocation.' });
  } else if (ecosystem === 'rust') {
    commands.push({ kind: 'lint', command: 'cargo clippy', source: 'synthetic' });
    commands.push({ kind: 'test', command: 'cargo test', source: 'synthetic' });
    commands.push({ kind: 'build', command: 'cargo build', source: 'synthetic' });
  } else if (ecosystem === 'go') {
    commands.push({ kind: 'test', command: 'go test ./...', source: 'synthetic' });
    commands.push({ kind: 'build', command: 'go build ./...', source: 'synthetic' });
  }
  return commands;
}

function filesExistAny(root: string, names: string[]): boolean {
  return names.some(name => fileExists(path.join(root, name)));
}

export function inspectProject(root: string, force = false): ProjectInfo {
  const absoluteRoot = path.resolve(root);
  const packageJsonPath = path.join(absoluteRoot, 'package.json');
  const packageJson = readJsonFile(packageJsonPath);
  const stampStat = (filePath: string): string | number => {
    try {
      const stat = fs.statSync(filePath);
      return stat.mtimeMs;
    } catch {
      return 'missing';
    }
  };
  const stamp = [
    stampStat(packageJsonPath),
    stampStat(path.join(absoluteRoot, 'pubspec.yaml')),
    stampStat(path.join(absoluteRoot, 'pubspec.lock')),
    stampStat(path.join(absoluteRoot, '.metadata')),
    stampStat(path.join(absoluteRoot, 'pyproject.toml')),
    stampStat(path.join(absoluteRoot, 'Cargo.toml')),
    stampStat(path.join(absoluteRoot, 'go.mod')),
    stampStat(path.join(absoluteRoot, 'bun.lock')),
    stampStat(path.join(absoluteRoot, 'package-lock.json')),
    stampStat(path.join(absoluteRoot, 'pnpm-lock.yaml')),
    stampStat(path.join(absoluteRoot, 'tsconfig.json')),
  ].join('|');

  if (!force) {
    const cached = cache.get(absoluteRoot);
    if (cached && cached.stamp === stamp) {
      if (cached.info.packageName) cached.info.packageName = String(packageJson?.name ?? cached.info.packageName);
      return cached.info;
    }
  }

  const pubspecPath = path.join(absoluteRoot, 'pubspec.yaml');
  const pubspec = fileExists(pubspecPath) ? readTextFileCapped(pubspecPath) : '';
  const isFlutterProject = /^[ \t]{2}(?:flutter|flutter_test):[ \t]*\r?\n[ \t]{4}sdk:[ \t]*flutter[ \t]*$/m.test(pubspec);
  const pyproject = fileExists(path.join(absoluteRoot, 'pyproject.toml'));
  const cargo = fileExists(path.join(absoluteRoot, 'Cargo.toml'));
  const goMod = fileExists(path.join(absoluteRoot, 'go.mod'));
  const composer = fileExists(path.join(absoluteRoot, 'composer.json'));
  const gemfile = fileExists(path.join(absoluteRoot, 'Gemfile'));
  const lockfiles: string[] = [];
  for (const candidate of ['package-lock.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'pubspec.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock']) {
    if (fileExists(path.join(absoluteRoot, candidate))) lockfiles.push(candidate);
  }
  const manifests = [packageJsonPath, 'pubspec.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', 'Makefile']
    .filter(candidate => fileExists(path.join(absoluteRoot, candidate)))
    .map(candidate => path.basename(candidate));

  let ecosystem: Ecosystem = 'unknown';
  if (fileExists(pubspecPath)) ecosystem = isFlutterProject ? 'flutter' : 'dart';
  else if (pyproject || filesExistAny(absoluteRoot, ['requirements.txt', 'setup.py', 'poetry.lock', 'uv.lock'])) ecosystem = 'python';
  else if (cargo) ecosystem = 'rust';
  else if (goMod) ecosystem = 'go';
  else if (composer) ecosystem = 'php';
  else if (gemfile) ecosystem = 'ruby';
  else if (packageJson || lockfiles.some(lock => ['package-lock.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock'].includes(lock))) {
    ecosystem = fileExists(path.join(absoluteRoot, 'bunfig.toml')) || lockfiles.some(lock => ['bun.lock', 'bun.lockb'].includes(lock)) ? 'bun' : 'node';
  }

  const scripts: Record<string, string> = {};
  const scriptsField = packageJson?.['scripts'];
  if (scriptsField && typeof scriptsField === 'object' && !Array.isArray(scriptsField)) {
    for (const [name, script] of Object.entries(scriptsField as Record<string, unknown>)) {
      if (typeof script === 'string') scripts[name] = script;
    }
  }

  const dependencies = {
    ...((packageJson?.['dependencies'] ?? {}) as Record<string, unknown>),
    ...((packageJson?.['devDependencies'] ?? {}) as Record<string, unknown>),
  };
  const frameworks: string[] = [];
  if (ecosystem === 'flutter') frameworks.push('Flutter');
  if (ecosystem === 'node' || ecosystem === 'bun') {
    for (const [hint, label] of NODE_FRAMEWORK_HINTS) {
      if (hint in dependencies && !frameworks.includes(label)) frameworks.push(label);
    }
  } else if (ecosystem === 'python') {
    const pythonManifest = readTextFileCapped(path.join(absoluteRoot, 'pyproject.toml')) + readTextFileCapped(path.join(absoluteRoot, 'requirements.txt'));
    for (const [hint, label] of PYTHON_FRAMEWORK_HINTS) {
      if (hint.test(pythonManifest) && !frameworks.includes(label)) frameworks.push(label);
    }
  }

  const hasTypeScript = typeof dependencies['typescript'] === 'string' || fileExists(path.join(absoluteRoot, 'tsconfig.json'));

  const languages: string[] = [];
  if (packageJson || ecosystem === 'node' || ecosystem === 'bun') languages.push('TypeScript/JavaScript');
  if (ecosystem === 'dart' || ecosystem === 'flutter') languages.push('Dart');
  if (ecosystem === 'python') languages.push('Python');
  if (cargo) languages.push('Rust');
  if (goMod) languages.push('Go');
  if (hasTypeScript && !languages.includes('TypeScript/JavaScript')) languages.push('TypeScript/JavaScript');

  const sourceDirs: string[] = [];
  try {
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (topLevelDirsIgnored.has(entry.name)) continue;
      if (['src', 'source', 'lib', 'app', 'packages', 'server', 'client', 'components', 'ui', 'py', 'python'].includes(entry.name)) sourceDirs.push(entry.name);
    }
  } catch { /* Unreadable root; discovery continues. */ }

  const entryPoints: string[] = [];
  for (const candidate of ['index.ts', 'index.tsx', 'index.js', 'main.py', 'main.go', 'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/main.ts', 'src/main.jsx', 'app.py', 'manage.py', 'lib/main.dart']) {
    if (fileExists(path.join(absoluteRoot, candidate))) entryPoints.push(candidate);
  }
  const mainField = typeof packageJson?.['main'] === 'string' ? packageJson['main'] as string : undefined;
  if (mainField && !entryPoints.includes(mainField) && fileExists(path.join(absoluteRoot, mainField))) entryPoints.unshift(mainField);

  const lintConfigFiles = filesExistAny(absoluteRoot, ['.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs', '.ruff.toml', 'ruff.toml', '.flake8', '.rubocop.yml']) ? ['configured'] : [];
  const testConfigFiles = filesExistAny(absoluteRoot, ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'pytest.ini', 'bunfig.toml', 'cypress.config.ts']) ? ['configured'] : [];
  const docFiles = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'].filter(name => fileExists(path.join(absoluteRoot, name)));

  const packageManager: PackageManager | undefined = (ecosystem === 'node' || ecosystem === 'bun') ? detectPackageManager(absoluteRoot, scripts) : undefined;
  const runnerBase = deriveRunner(ecosystem, packageManager);
  const verifyCommands = buildVerifyCommands(absoluteRoot, ecosystem, runnerBase, scripts, hasTypeScript, packageManager);

  const info: ProjectInfo = {
    root: absoluteRoot,
    relativeRoot: '.',
    ecosystem,
    packageManager,
    runnerBase,
    packageName: typeof packageJson?.['name'] === 'string' ? packageJson['name'] as string : undefined,
    version: typeof packageJson?.['version'] === 'string' ? packageJson['version'] as string : undefined,
    frameworks,
    languages,
    scripts,
    lockfiles,
    manifests,
    hasTypeScript,
    sourceDirs,
    entryPoints,
    lintConfigFiles,
    testConfigFiles,
    verifyCommands,
    docFiles,
  };
  cache.set(absoluteRoot, { stamp, info });
  return info;
}

export function invalidateProjectCache(root?: string): void {
  if (root) cache.delete(path.resolve(root));
  else cache.clear();
}

export interface ProjectMap {
  root: string;
  ecosystem: string;
  packageManager: string | undefined;
  frameworks: string[];
  topDirs: Array<{ name: string; files: number; dirs: number }>;
  keyFiles: string[];
  sourceSummary: string[];
}

export function getProjectMap(root: string): ProjectMap {
  const info = inspectProject(root);
  const summary = getIndexSummary(root);
  return {
    root: info.root,
    ecosystem: info.ecosystem,
    packageManager: info.packageManager,
    frameworks: info.frameworks,
    topDirs: summary.topDirs.slice(0, 20).map(entry => ({
      name: entry.path,
      files: entry.files,
      dirs: entry.dirs,
    })),
    keyFiles: summary.keyFiles.slice(0, 50),
    sourceSummary: summary.sourceSummary.slice(0, 15),
  };
}

export function getProjectScripts(root: string): { packageManager?: PackageManager; runnerBase: string; scripts: Record<string, string>; verifyCommands: VerifyCommand[] } {
  const info = inspectProject(root);
  return {
    packageManager: info.packageManager,
    runnerBase: info.runnerBase,
    scripts: info.scripts,
    verifyCommands: info.verifyCommands,
  };
}
