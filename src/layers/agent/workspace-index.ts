import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceStateKey } from './taskstate';
import { scanFileLines } from './text-lines';

export type FileCategory = 'source' | 'test' | 'config' | 'doc' | 'asset' | 'other';

export interface IndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  ext: string;
  language: string;
  category: FileCategory;
  lineCount?: number;
  hash?: string;
  outline?: string[];
}

export interface IndexedDirectory {
  path: string;
  files: number;
  dirs: number;
}

export interface WorkspaceIndexData {
  version: 1;
  root: string;
  generatedAt: string;
  validatedAt: string;
  rootMtimeMs: number;
  files: IndexedFile[];
  directories: string[];
  truncated: boolean;
}

export interface IndexChanges {
  added: string[];
  removed: string[];
  modified: string[];
}

export interface RefreshResult {
  index: WorkspaceIndexData;
  changes: IndexChanges;
}

export interface WorkspaceIndexStatus {
  path: string;
  exists: boolean;
  fileCount: number;
  generatedAt?: string;
  stale: boolean;
  truncated: boolean;
}

export interface IndexSummary {
  root: string;
  fileCount: number;
  directoryCount: number;
  languages: Record<string, number>;
  categories: Record<string, number>;
  topDirs: IndexedDirectory[];
  keyFiles: string[];
  sourceSummary: string[];
  recentChanges: string[];
  generatedAt: string;
  truncated: boolean;
  stale: boolean;
}

export interface ListIndexResult {
  entries: Array<{ name: string; type: 'file' | 'directory' }>;
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  truncated: boolean;
}

export interface FindIndexResult {
  files: string[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchIndexResult {
  matches: SearchMatch[];
  truncated: boolean;
  nextCursor: string | null;
  scannedFiles: number;
  bytesScanned: number;
}

const INDEX_VERSION = 1 as const;
const MAX_INDEXED_FILES = 100_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const INDEX_TTL_MS = 5_000;
const MAX_OUTLINE_LINES = 40;

const IGNORED_DIRECTORIES = new Set<string>([
  '.git', 'node_modules', '.dash', 'dist', 'build', 'out', 'coverage',
  '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'vendor',
  '.next', '.nuxt', '.turbo', '.cache', '.idea', '.vscode', '.DS_Store',
]);

const IGNORED_FILES = new Set<string>([
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.dart': 'Dart',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.rs': 'Rust', '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cc': 'C++',
  '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.sh': 'Shell',
  '.ps1': 'PowerShell', '.sql': 'SQL', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.less': 'Less', '.vue': 'Vue', '.svelte': 'Svelte', '.json': 'JSON', '.jsonc': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.md': 'Markdown', '.mdx': 'MDX',
  '.xml': 'XML', '.graphql': 'GraphQL', '.proto': 'Protocol Buffers', '.lua': 'Lua',
};

const CONFIG_EXTS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.lock', '.ini', '.cfg', '.conf', '.env']);
const DOC_EXTS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.zip', '.gz', '.tar', '.pdf']);

interface IgnoreRule {
  regex: RegExp;
  negated: boolean;
}

const memory = new Map<string, { data: WorkspaceIndexData; validatedAt: number }>();

function dashDataDir(): string {
  return process.env.DASH_DATA_DIR ? path.resolve(process.env.DASH_DATA_DIR) : path.join(os.homedir(), '.dash');
}

export function workspaceIndexPath(root: string): string {
  return path.join(dashDataDir(), 'workspace-index', `${workspaceStateKey(root)}.json`);
}

function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === '.' ? '' : normalized.replace(/\/+$/, '');
}

function categoryFor(relativePath: string): FileCategory {
  const ext = path.extname(relativePath).toLowerCase();
  const lower = relativePath.toLowerCase();
  if (ASSET_EXTS.has(ext)) return 'asset';
  if (DOC_EXTS.has(ext) || /(^|\/)(readme|license|changelog|contributing)(\.|$)/.test(lower)) return 'doc';
  if (CONFIG_EXTS.has(ext) || /(^|\/)(tsconfig|package|bunfig|vite|webpack|rollup|eslint|prettier|jest|vitest|playwright|docker|compose|makefile)/.test(lower)) return 'config';
  if (/(^|\/)(tests?|__tests__|spec)(\/|\.)|\.(test|spec)\.[^.]+$/.test(lower)) return 'test';
  if (LANGUAGE_BY_EXT[ext] && !['JSON', 'YAML', 'TOML', 'Markdown', 'MDX', 'XML'].includes(LANGUAGE_BY_EXT[ext] ?? '')) return 'source';
  return 'other';
}

function languageFor(relativePath: string): string {
  return LANGUAGE_BY_EXT[path.extname(relativePath).toLowerCase()] ?? 'Unknown';
}

export function globToRegExp(pattern: string, anchored = true): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else if (char) {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${regex}$`);
}

export function matchesWorkspaceGlob(value: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.includes('/')) {
    const basename = value.split('/').pop() ?? value;
    return globToRegExp(normalized, true).test(basename);
  }
  return globToRegExp(normalized, true).test(value.replace(/\\/g, '/'));
}

function readIgnoreRules(root: string): IgnoreRule[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    if (!pattern) continue;
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    let anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    if (!pattern) continue;
    if (pattern.includes('/')) anchored = true;
    let regex = globToRegExp(pattern, anchored).source;
    if (dirOnly) {
      regex = regex.replace(/\$$/, '(?:/.*)?$');
    }
    rules.push({ regex: new RegExp(regex), negated });
  }
  return rules;
}

function isIgnored(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some(segment => IGNORED_DIRECTORIES.has(segment))) return true;
  if (!isDirectory && IGNORED_FILES.has(segments[segments.length - 1] ?? '')) return true;
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(normalized) || (isDirectory && rule.regex.test(`${normalized}/`))) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function statRootMtime(root: string): number {
  try {
    return fs.statSync(root).mtimeMs;
  } catch {
    return 0;
  }
}

function emptyIndex(root: string): WorkspaceIndexData {
  return {
    version: INDEX_VERSION,
    root,
    generatedAt: new Date(0).toISOString(),
    validatedAt: new Date(0).toISOString(),
    rootMtimeMs: statRootMtime(root),
    files: [],
    directories: [],
    truncated: false,
  };
}

function parseIndex(raw: unknown, root: string): WorkspaceIndexData | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<WorkspaceIndexData>;
  if (candidate.version !== INDEX_VERSION || candidate.root !== root) return undefined;
  if (!Array.isArray(candidate.files) || !Array.isArray(candidate.directories)) return undefined;
  const files = candidate.files.filter((file): file is IndexedFile =>
    Boolean(file)
    && typeof file.path === 'string'
    && typeof file.size === 'number'
    && typeof file.mtimeMs === 'number'
    && typeof file.ext === 'string'
    && typeof file.language === 'string'
    && typeof file.category === 'string',
  );
  return {
    version: INDEX_VERSION,
    root,
    generatedAt: typeof candidate.generatedAt === 'string' ? candidate.generatedAt : new Date(0).toISOString(),
    validatedAt: typeof candidate.validatedAt === 'string' ? candidate.validatedAt : new Date(0).toISOString(),
    rootMtimeMs: typeof candidate.rootMtimeMs === 'number' ? candidate.rootMtimeMs : 0,
    files,
    directories: candidate.directories.filter((entry): entry is string => typeof entry === 'string'),
    truncated: candidate.truncated === true,
  };
}

function readIndexFile(root: string): WorkspaceIndexData | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(workspaceIndexPath(root), 'utf8'));
    return parseIndex(parsed, root);
  } catch {
    return undefined;
  }
}

function writeIndexFile(data: WorkspaceIndexData): void {
  const target = workspaceIndexPath(data.root);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), 'utf8');
    try {
      fs.renameSync(temporary, target);
    } catch {
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup. */ }
  }
}

function scanTree(root: string, previous: Map<string, IndexedFile>): { files: IndexedFile[]; directories: string[]; truncated: boolean } {
  const files: IndexedFile[] = [];
  const directories: string[] = [];
  const rules = readIgnoreRules(root);
  let truncated = false;

  const visit = (directory: string, relativeDirectory: string): void => {
    if (files.length >= MAX_INDEXED_FILES) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (isIgnored(relative, true, rules)) continue;
        directories.push(relative);
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || isIgnored(relative, false, rules)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolute);
      } catch {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const old = previous.get(relative);
      if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) {
        files.push(old);
      } else {
        files.push({
          path: relative,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ext,
          language: languageFor(relative),
          category: categoryFor(relative),
        });
      }
    }
  };

  const rootStat = (() => {
    try { return fs.statSync(root); } catch { return undefined; }
  })();
  if (rootStat?.isDirectory()) visit(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort((a, b) => a.localeCompare(b));
  return { files, directories, truncated };
}

export function refreshWorkspaceIndex(root: string): RefreshResult {
  const absoluteRoot = path.resolve(root);
  const previousData = memory.get(absoluteRoot)?.data ?? readIndexFile(absoluteRoot) ?? emptyIndex(absoluteRoot);
  const previous = new Map(previousData.files.map(file => [file.path, file]));
  const scanned = scanTree(absoluteRoot, previous);
  const nextPaths = new Set(scanned.files.map(file => file.path));
  const changes: IndexChanges = { added: [], removed: [], modified: [] };
  for (const file of scanned.files) {
    const old = previous.get(file.path);
    if (!old) changes.added.push(file.path);
    else if (old.size !== file.size || old.mtimeMs !== file.mtimeMs) changes.modified.push(file.path);
  }
  for (const file of previousData.files) {
    if (!nextPaths.has(file.path)) changes.removed.push(file.path);
  }
  const data: WorkspaceIndexData = {
    version: INDEX_VERSION,
    root: absoluteRoot,
    generatedAt: new Date().toISOString(),
    validatedAt: new Date().toISOString(),
    rootMtimeMs: statRootMtime(absoluteRoot),
    files: scanned.files,
    directories: scanned.directories,
    truncated: scanned.truncated,
  };
  writeIndexFile(data);
  memory.set(absoluteRoot, { data, validatedAt: Date.now() });
  return { index: data, changes };
}

export function loadWorkspaceIndex(root: string): WorkspaceIndexData {
  const absoluteRoot = path.resolve(root);
  const cached = memory.get(absoluteRoot);
  if (cached) return cached.data;
  const loaded = readIndexFile(absoluteRoot);
  if (loaded) {
    memory.set(absoluteRoot, { data: loaded, validatedAt: 0 });
    return loaded;
  }
  return refreshWorkspaceIndex(absoluteRoot).index;
}

export function ensureWorkspaceIndex(root: string, ttlMs = INDEX_TTL_MS): WorkspaceIndexData {
  const absoluteRoot = path.resolve(root);
  const cached = memory.get(absoluteRoot) ?? (() => {
    const loaded = readIndexFile(absoluteRoot);
    if (!loaded) return undefined;
    const entry = { data: loaded, validatedAt: 0 };
    memory.set(absoluteRoot, entry);
    return entry;
  })();
  if (cached && cached.validatedAt > 0) {
    const rootMtimeMs = statRootMtime(absoluteRoot);
    if (Date.now() - cached.validatedAt <= ttlMs && rootMtimeMs === cached.data.rootMtimeMs) {
      return cached.data;
    }
  }
  return refreshWorkspaceIndex(absoluteRoot).index;
}

export function invalidateWorkspaceIndex(root?: string): void {
  if (!root) {
    for (const entry of memory.values()) {
      try { fs.rmSync(workspaceIndexPath(entry.data.root), { force: true }); } catch { /* Best-effort. */ }
    }
    memory.clear();
    return;
  }
  const absoluteRoot = path.resolve(root);
  memory.delete(absoluteRoot);
  try { fs.rmSync(workspaceIndexPath(absoluteRoot), { force: true }); } catch { /* Best-effort. */ }
}

function ensureParentDirectories(index: WorkspaceIndexData, relative: string): void {
  const segments = relative.split('/');
  segments.pop();
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!index.directories.includes(current)) index.directories.push(current);
  }
  index.directories.sort((a, b) => a.localeCompare(b));
}

export function updateIndexedFile(root: string, relative: string, extra: Partial<Pick<IndexedFile, 'lineCount' | 'hash' | 'outline'>> = {}): IndexedFile | undefined {
  const absoluteRoot = path.resolve(root);
  const normalized = normalizeRelative(relative);
  const index = ensureWorkspaceIndex(absoluteRoot);
  const absolute = path.join(absoluteRoot, normalized);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    removeIndexedFile(absoluteRoot, normalized);
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const existing = index.files.find(file => file.path === normalized);
  const unchanged = Boolean(existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs);
  const derived = unchanged && existing
    ? {
        ...(existing.lineCount !== undefined ? { lineCount: existing.lineCount } : {}),
        ...(existing.hash !== undefined ? { hash: existing.hash } : {}),
        ...(existing.outline !== undefined ? { outline: existing.outline } : {}),
      }
    : {};
  const next: IndexedFile = {
    path: normalized,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ext: path.extname(normalized).toLowerCase(),
    language: languageFor(normalized),
    category: categoryFor(normalized),
    ...derived,
    ...extra,
  };
  const files = existing
    ? index.files.map(file => file.path === normalized ? next : file)
    : [...index.files, next];
  index.files = files.sort((a, b) => a.path.localeCompare(b.path));
  ensureParentDirectories(index, normalized);
  index.validatedAt = new Date().toISOString();
  index.rootMtimeMs = statRootMtime(absoluteRoot);
  writeIndexFile(index);
  memory.set(absoluteRoot, { data: index, validatedAt: Date.now() });
  return next;
}

export function removeIndexedFile(root: string, relative: string): void {
  const absoluteRoot = path.resolve(root);
  const normalized = normalizeRelative(relative);
  const index = ensureWorkspaceIndex(absoluteRoot);
  const before = index.files.length + index.directories.length;
  index.files = index.files.filter(file => file.path !== normalized && !file.path.startsWith(`${normalized}/`));
  index.directories = index.directories.filter(directory => directory !== normalized && !directory.startsWith(`${normalized}/`));
  if (index.files.length + index.directories.length === before) return;
  index.validatedAt = new Date().toISOString();
  writeIndexFile(index);
  memory.set(absoluteRoot, { data: index, validatedAt: Date.now() });
}

export function getIndexStatus(root: string): WorkspaceIndexStatus {
  const absoluteRoot = path.resolve(root);
  const indexFile = workspaceIndexPath(absoluteRoot);
  const cached = memory.get(absoluteRoot)?.data ?? readIndexFile(absoluteRoot);
  const exists = fs.existsSync(indexFile);
  if (!cached) {
    return { path: indexFile, exists, fileCount: 0, stale: true, truncated: false };
  }
  const rootMtimeMs = statRootMtime(absoluteRoot);
  return {
    path: indexFile,
    exists,
    fileCount: cached.files.length,
    generatedAt: cached.generatedAt,
    stale: rootMtimeMs !== cached.rootMtimeMs,
    truncated: cached.truncated,
  };
}

function topLevelDirectories(index: WorkspaceIndexData): IndexedDirectory[] {
  const counts = new Map<string, { files: number; dirs: number }>();
  for (const file of index.files) {
    const top = file.path.split('/')[0];
    if (!top || top === file.path) continue;
    const entry = counts.get(top) ?? { files: 0, dirs: 0 };
    entry.files += 1;
    counts.set(top, entry);
  }
  for (const directory of index.directories) {
    const segments = directory.split('/');
    if (segments.length !== 1) continue;
    const entry = counts.get(directory) ?? { files: 0, dirs: 0 };
    entry.dirs += 1;
    counts.set(directory, entry);
  }
  return [...counts.entries()]
    .map(([name, value]) => ({ path: name, files: value.files, dirs: value.dirs }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

export function getIndexSummary(root: string): IndexSummary {
  const index = ensureWorkspaceIndex(root);
  const languages: Record<string, number> = {};
  const categories: Record<string, number> = {};
  for (const file of index.files) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
    categories[file.category] = (categories[file.category] ?? 0) + 1;
  }
  const topDirs = topLevelDirectories(index);
  const keyFiles = index.files
    .filter(file => !file.path.includes('/') && (file.category === 'config' || file.category === 'doc' || file.ext === '.lock'))
    .map(file => file.path);
  return {
    root: index.root,
    fileCount: index.files.length,
    directoryCount: index.directories.length,
    languages,
    categories,
    topDirs: topDirs.slice(0, 20),
    keyFiles,
    sourceSummary: topDirs.slice(0, 20).map(entry => `${entry.path}/ (${entry.files} files)`),
    recentChanges: [...index.files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10).map(file => file.path),
    generatedAt: index.generatedAt,
    truncated: index.truncated,
    stale: statRootMtime(index.root) !== index.rootMtimeMs,
  };
}

function withinDirectory(relative: string, directory: string): boolean {
  if (!directory) return true;
  return relative === directory || relative.startsWith(`${directory}/`);
}

export function listIndexed(
  root: string,
  relativeDirectory = '',
  recursive = false,
  pattern?: string,
  offset = 0,
  limit = DEFAULT_PAGE_LIMIT,
): ListIndexResult {
  const index = ensureWorkspaceIndex(root);
  const directory = normalizeRelative(relativeDirectory);
  const entries: Array<{ name: string; type: 'file' | 'directory' }> = [];
  const prefix = directory ? `${directory}/` : '';
  for (const file of index.files) {
    if (!withinDirectory(file.path, directory) || file.path === directory) continue;
    const rest = file.path.slice(prefix.length);
    if (!recursive && rest.includes('/')) continue;
    const name = recursive ? file.path : rest;
    if (pattern && !matchesWorkspaceGlob(name, pattern)) continue;
    entries.push({ name, type: 'file' });
  }
  for (const dir of index.directories) {
    if (!withinDirectory(dir, directory) || dir === directory) continue;
    const rest = dir.slice(prefix.length);
    if (!rest) continue;
    if (!recursive && rest.includes('/')) continue;
    const name = recursive ? dir : rest;
    if (pattern && !matchesWorkspaceGlob(name, pattern)) continue;
    entries.push({ name, type: 'directory' });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(limit)));
  const selected = entries.slice(safeOffset, safeOffset + safeLimit);
  const next = safeOffset + selected.length;
  return {
    entries: selected,
    total: entries.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: next < entries.length ? next : null,
    truncated: next < entries.length,
  };
}

export function findIndexed(root: string, pattern: string, offset = 0, limit = DEFAULT_PAGE_LIMIT, scope = ''): FindIndexResult {
  const index = ensureWorkspaceIndex(root);
  const directory = normalizeRelative(scope);
  const files = index.files
    .map(file => file.path)
    .filter(file => withinDirectory(file, directory))
    .filter(file => matchesWorkspaceGlob(file, pattern))
    .sort((a, b) => a.localeCompare(b));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(limit)));
  const selected = files.slice(safeOffset, safeOffset + safeLimit);
  const next = safeOffset + selected.length;
  return {
    files: selected,
    total: files.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: next < files.length ? next : null,
    truncated: next < files.length,
  };
}

export interface SearchIndexOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  cursor?: string;
  limit?: number;
  includeTests?: boolean;
  path?: string;
}

function parseCursor(cursor: string | undefined): { path: string; line: number } | undefined {
  if (!cursor) return undefined;
  const split = cursor.lastIndexOf(':');
  if (split <= 0) return undefined;
  const line = Number(cursor.slice(split + 1));
  if (!Number.isInteger(line) || line < 0) return undefined;
  return { path: cursor.slice(0, split), line };
}

export async function searchIndexed(root: string, query: string, options: SearchIndexOptions = {}): Promise<SearchIndexResult> {
  const index = ensureWorkspaceIndex(root);
  const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(options.limit ?? DEFAULT_PAGE_LIMIT)));
  const regex = options.regex ? new RegExp(query, options.caseSensitive ? '' : 'i') : undefined;
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const cursor = parseCursor(options.cursor);
  const scope = normalizeRelative(options.path ?? '');
  const files = index.files
    .filter(file => file.size <= MAX_SEARCH_FILE_BYTES && file.category !== 'asset')
    .filter(file => options.includeTests === false ? file.category !== 'test' : true)
    .filter(file => withinDirectory(file.path, scope))
    .sort((a, b) => a.path.localeCompare(b.path));
  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let bytesScanned = 0;
  let truncated = false;

  for (const file of files) {
    if (truncated) break;
    if (cursor && file.path < cursor.path) continue;
    scannedFiles += 1;
    const result = await scanFileLines(path.join(index.root, file.path), line => {
      if (cursor && file.path === cursor.path && line.line <= cursor.line) return;
      const found = regex
        ? (() => { regex.lastIndex = 0; return regex.test(line.text); })()
        : (options.caseSensitive ? line.text.includes(needle) : line.text.toLowerCase().includes(needle));
      if (!found) return;
      matches.push({ path: file.path, line: line.line, text: line.text.slice(0, 240) });
      if (matches.length > limit) {
        truncated = true;
        return false;
      }
    });
    bytesScanned += result.bytesScanned;
  }

  if (matches.length > limit) matches.pop();
  const last = matches[matches.length - 1];
  return {
    matches,
    truncated,
    nextCursor: truncated && last ? `${last.path}:${last.line}` : null,
    scannedFiles,
    bytesScanned,
  };
}

export function getRecentChanges(root: string, limit = 20): IndexedFile[] {
  const index = ensureWorkspaceIndex(root);
  return [...index.files]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
}

export function getIndexedFile(root: string, relative: string): IndexedFile | undefined {
  const index = ensureWorkspaceIndex(root);
  const normalized = normalizeRelative(relative);
  return index.files.find(file => file.path === normalized);
}

export function updateIndexFromRead(root: string, relative: string, details: { lineCount?: number; hash?: string; outline?: string[] }): IndexedFile | undefined {
  const normalized = normalizeRelative(relative);
  const file = getIndexedFile(root, normalized);
  if (!file) return updateIndexedFile(root, normalized, details);
  const outline = details.outline?.slice(0, MAX_OUTLINE_LINES);
  const changed = (details.lineCount !== undefined && file.lineCount !== details.lineCount)
    || (details.hash !== undefined && file.hash !== details.hash)
    || (outline !== undefined && JSON.stringify(file.outline ?? []) !== JSON.stringify(outline));
  if (!changed) return file;
  const updated: IndexedFile = {
    ...file,
    ...(details.lineCount !== undefined ? { lineCount: details.lineCount } : {}),
    ...(details.hash !== undefined ? { hash: details.hash } : {}),
    ...(outline !== undefined ? { outline } : {}),
  };
  const index = ensureWorkspaceIndex(root);
  index.files = index.files.map(candidate => candidate.path === normalized ? updated : candidate);
  writeIndexFile(index);
  memory.set(path.resolve(root), { data: index, validatedAt: Date.now() });
  return updated;
}
