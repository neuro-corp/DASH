import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getIndexedFile, loadWorkspaceIndex, matchesWorkspaceGlob, searchIndexed } from './workspace-index';
import { readLineRange } from './text-lines';

export type CodeSearchType = 'auto' | 'content' | 'filename' | 'symbol' | 'import' | 'reference';

export interface CodebaseSearchOptions {
  query: string;
  searchType?: CodeSearchType;
  scope?: string[];
  exclude?: string[];
  maxResults?: number;
  contextLines?: number;
}

export interface CodebaseSearchResult {
  query: string;
  results: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    matchType: string;
    relevance: number;
    symbol?: string;
    snippet: string;
  }>;
  totalMatches: number;
  truncated: boolean;
  cached: boolean;
  engine: 'workspace-index-heuristic';
}

export interface FileOutline {
  filePath: string;
  language: string;
  symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }>;
  imports: Array<{ source: string; line: number }>;
  exports: Array<{ name: string; line: number }>;
  cached?: boolean;
  truncated?: boolean;
  engine: 'text-heuristic';
}

const MAX_CACHED_RESULTS = 64;
const CACHE_TTL_MS = 2_000;
const resultCache = new Map<string, { expiresAt: number; value: unknown; files: Array<{ path: string; size: number; mtimeMs: number }> }>();
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'at', 'for', 'find', 'function', 'implemented', 'in', 'is', 'it', 'of', 'on', 'page', 'the', 'to', 'where', 'with']);

async function remember<T>(key: string, value: T, filePaths: string[] = []): Promise<T> {
  resultCache.delete(key);
  const files = await Promise.all([...new Set(filePaths)].map(async filePath => {
    try {
      const stat = await fs.stat(filePath);
      return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch { return undefined; }
  }));
  resultCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value, files: files.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) });
  while (resultCache.size > MAX_CACHED_RESULTS) {
    const oldest = resultCache.keys().next().value as string | undefined;
    if (!oldest) break;
    resultCache.delete(oldest);
  }
  return value;
}

async function cacheIsFresh(key: string): Promise<boolean> {
  const entry = resultCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  for (const previous of entry.files) {
    try {
      const current = await fs.stat(previous.path);
      if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) return false;
    } catch { return false; }
  }
  return true;
}

function cached<T>(key: string): T | undefined {
  const entry = resultCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return undefined;
  }
  resultCache.delete(key);
  resultCache.set(key, entry);
  return entry.value as T;
}

export function invalidateCodebaseCache(root: string): void {
  const prefix = `${path.resolve(root)}\u0000`;
  for (const key of resultCache.keys()) if (key.startsWith(prefix)) resultCache.delete(key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryTerms(query: string): string[] {
  return [...new Set((query.match(/[A-Za-z_$][\w$-]*/g) ?? [])
    .map(term => term.toLowerCase())
    .filter(term => term.length > 1 && !STOP_WORDS.has(term)))].slice(0, 8);
}

function pathInScope(filePath: string, scopes: string[]): boolean {
  return scopes.length === 0 || scopes.some(scope => {
    const normalized = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return !normalized || filePath === normalized || filePath.startsWith(`${normalized}/`);
  });
}

function isExcluded(filePath: string, excludes: string[]): boolean {
  return excludes.some(pattern => matchesWorkspaceGlob(filePath, pattern) || filePath.includes(pattern.replace(/\\/g, '/')));
}

function classifyLine(line: string, searchType: CodeSearchType): { type: string; symbol?: string } {
  const declaration = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
  const component = /^\s*(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z\d_$]*)/.exec(line);
  const imported = /^\s*import\b/.test(line) || /^\s*(?:const|let)\s+\w+\s*=\s*require\(/.test(line);
  const jsxUsage = /<([A-Z][A-Za-z\d_$]*)\b/.exec(line);
  const symbol = component?.[1] ?? declaration?.[1] ?? jsxUsage?.[1];
  if (searchType === 'import' || (searchType === 'auto' && imported)) return { type: 'import', ...(symbol ? { symbol } : {}) };
  if (searchType === 'symbol' || declaration) return { type: component ? 'component_declaration' : 'symbol_declaration', ...(symbol ? { symbol } : {}) };
  if (jsxUsage) return { type: 'component_usage', symbol: jsxUsage[1] };
  if (searchType === 'reference') return { type: 'reference', ...(symbol ? { symbol } : {}) };
  return { type: 'content', ...(symbol ? { symbol } : {}) };
}

export async function searchCodebase(root: string, options: CodebaseSearchOptions): Promise<CodebaseSearchResult> {
  const query = options.query.trim();
  if (!query) throw new Error('query is required');
  const searchType = options.searchType ?? 'auto';
  const maxResults = Math.max(1, Math.min(50, Math.trunc(options.maxResults ?? 10)));
  const contextLines = Math.max(0, Math.min(5, Math.trunc(options.contextLines ?? 1)));
  const scopes = (options.scope ?? []).map(scope => scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
  const excludes = options.exclude ?? [];
  const cacheKey = `${path.resolve(root)}\u0000${JSON.stringify({ query: query.toLowerCase(), searchType, scopes, excludes, maxResults, contextLines })}`;
  const hit = cached<CodebaseSearchResult>(cacheKey);
  if (hit) {
    if (await cacheIsFresh(cacheKey)) return { ...hit, cached: true };
    resultCache.delete(cacheKey);
  }

  const terms = queryTerms(query);
  const candidates = new Map<string, { filePath: string; line: number; text: string; relevance: number; matchType: string; symbol?: string }>();
  const filenameQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const filenameTerms = queryTerms(query);
  if (searchType === 'auto' || searchType === 'filename') {
    const indexed = loadWorkspaceIndex(root).files.map(file => file.path);
    for (const filePath of indexed) {
      if (!pathInScope(filePath, scopes) || isExcluded(filePath, excludes)) continue;
      const basename = path.basename(filePath).toLowerCase();
      const normalized = basename.replace(/[^a-z0-9]+/g, ' ');
      let score = basename === filenameQuery.replace(/\s+/g, '') ? 1 : 0;
      for (const term of filenameTerms) {
        if (basename.includes(term)) score += 0.18;
        if (normalized.includes(term)) score += 0.1;
      }
      if (score > 0) {
        candidates.set(`${filePath}:1`, { filePath, line: 1, text: `File name: ${basename}`, relevance: Math.min(0.98, score), matchType: 'filename' });
      }
    }
  }

  if (searchType !== 'filename' && terms.length > 0) {
    const expression = terms.map(escapeRegExp).join('|');
    const found = await searchIndexed(root, expression, { regex: true, limit: 500, includeTests: false });
    for (const match of found.matches) {
      if (!pathInScope(match.path, scopes) || isExcluded(match.path, excludes)) continue;
      const text = match.text;
      const lower = text.toLowerCase();
      const hits = terms.filter(term => lower.includes(term)).length;
      const classified = classifyLine(text, searchType);
      let score = 0.28 + (hits / terms.length) * 0.42;
      if (classified.type.includes('declaration')) score += 0.18;
      if (classified.type === 'component_usage') score += 0.12;
      if (classified.type === 'import') score += searchType === 'import' ? 0.2 : 0.04;
      if (searchType === 'symbol' && classified.type.includes('declaration')) score += 0.14;
      if (searchType === 'reference' && lower.includes(query.toLowerCase())) score += 0.16;
      const pathLower = match.path.toLowerCase();
      for (const term of terms) if (pathLower.includes(term)) score += 0.04;
      candidates.set(`${match.path}:${match.line}`, {
        filePath: match.path,
        line: match.line,
        text,
        relevance: Math.min(0.99, score),
        matchType: classified.type,
        ...(classified.symbol ? { symbol: classified.symbol } : {}),
      });
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => b.relevance - a.relevance || a.filePath.localeCompare(b.filePath) || a.line - b.line);
  const totalMatches = ranked.length;
  const results = await Promise.all(ranked.slice(0, maxResults).map(async match => {
    const start = Math.max(1, match.line - contextLines);
    let end = match.line;
    let snippet = `${match.line}: ${match.text}`;
    try {
      const read = await readLineRange(path.join(root, match.filePath), start, contextLines * 2 + 1);
      end = read.endLine;
      snippet = read.lines.map(line => `${line.line}: ${line.text}`).join('\n').slice(0, 1_200);
    } catch { /* Index may race with removal or include a non-text filename match. */ }
    return {
      filePath: match.filePath,
      startLine: start,
      endLine: end,
      matchLine: match.line,
      matchType: match.matchType,
      relevance: Number(match.relevance.toFixed(3)),
      ...(match.symbol ? { symbol: match.symbol } : {}),
      snippet,
    };
  }));
  return remember(cacheKey, { query, results, totalMatches, truncated: totalMatches > results.length, cached: false, engine: 'workspace-index-heuristic' }, results.map(result => path.join(root, result.filePath)));
}

const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var|def|fn|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/;

function declarationEndLine(lines: string[], startIndex: number, fallback: number): number {
  let depth = 0;
  let opened = false;
  let blockComment = false;
  let quote = '';
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    for (let index = 0; index < line.length; index++) {
      const current = line[index] ?? '';
      const next = line[index + 1] ?? '';
      if (blockComment) {
        if (current === '*' && next === '/') { blockComment = false; index++; }
        continue;
      }
      if (quote) {
        if (current === '\\') { index++; continue; }
        if (current === quote) quote = '';
        continue;
      }
      if (current === '/' && next === '/') break;
      if (current === '/' && next === '*') { blockComment = true; index++; continue; }
      if (current === '"' || current === "'" || current === '`') { quote = current; continue; }
      if (current === '{') { opened = true; depth++; }
      if (current === '}' && opened && --depth === 0) return lineIndex + 1;
    }
    if (!opened && lineIndex > startIndex && DECLARATION.test(line)) return lineIndex;
    if (!opened && lineIndex === startIndex && /;\s*$/.test(line)) return lineIndex + 1;
  }
  return Math.max(startIndex + 1, fallback);
}

export async function getFileOutline(root: string, relativePath: string): Promise<FileOutline> {
  const fullPath = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path must remain inside the workspace.');
  const stat = await fs.stat(fullPath);
  const cacheKey = `${path.resolve(root)}\u0000outline\u0000${relative}:${stat.size}:${stat.mtimeMs}`;
  const hit = cached<FileOutline>(cacheKey);
  if (hit) return { ...hit, cached: true };
  const read = await readLineRange(fullPath, 1, 2_000);
  const lines = read.lines.map(line => line.text);
  const declarations: Array<{ name: string; kind: string; startLine: number }> = [];
  const imports: Array<{ source: string; line: number }> = [];
  const exports: Array<{ name: string; line: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const declaration = DECLARATION.exec(line);
    if (declaration?.[2]) {
      const rawKind = declaration[1] ?? 'symbol';
      const kind = /^[A-Z]/.test(declaration[2]) && (rawKind === 'function' || (rawKind === 'const' && /(?:=>|\bfunction\b)/.test(line)))
        ? 'component'
        : rawKind;
      declarations.push({ name: declaration[2], kind, startLine: index + 1 });
    }
    const imported = /^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/.exec(line) ?? /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
    if (imported?.[1]) imports.push({ source: imported[1], line: index + 1 });
    const exported = /^\s*export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (exported?.[1]) exports.push({ name: exported[1], line: index + 1 });
  }
  const symbols = declarations.slice(0, 200).map((symbol, index) => ({
    ...symbol,
    endLine: declarationEndLine(lines, symbol.startLine - 1, (declarations[index + 1]?.startLine ?? lines.length + 1) - 1),
  }));
  return remember(cacheKey, { filePath: relative.replace(/\\/g, '/'), language: getIndexedFile(root, relative)?.language ?? (path.extname(relative).slice(1) || 'unknown'), symbols, imports, exports, cached: false, truncated: read.truncated, engine: 'text-heuristic' }, [fullPath]);
}

export async function findSymbol(root: string, name: string, scopes: string[] = [], limit = 50): Promise<{ name: string; declarations: unknown[]; references: unknown[]; truncated: boolean }> {
  const symbol = name.trim();
  if (!symbol) throw new Error('name is required');
  const escaped = escapeRegExp(symbol);
  const [declarations, references] = await Promise.all([
    searchIndexed(root, `\\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|impl)\\s+${escaped}\\b`, { regex: true, limit, includeTests: true }),
    searchIndexed(root, `\\b${escaped}\\b`, { regex: true, limit: Math.min(200, limit * 3), includeTests: true }),
  ]);
  const inScopes = (match: { path: string }) => pathInScope(match.path, scopes);
  const declared = declarations.matches.filter(inScopes).map(match => ({ filePath: match.path, line: match.line, snippet: match.text }));
  const refs = references.matches.filter(inScopes).map(match => ({ filePath: match.path, line: match.line, snippet: match.text }));
  return { name: symbol, declarations: declared, references: refs, truncated: declarations.truncated || references.truncated };
}
