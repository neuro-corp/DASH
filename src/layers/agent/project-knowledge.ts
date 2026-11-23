import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectProject, type ProjectInfo } from './project';
import { getIndexSummary, type IndexSummary } from './workspace-index';

export type KnowledgeConfidence = 'documented' | 'observed' | 'inferred';

export interface KnowledgeSource {
  path: string;
  kind: 'manifest' | 'document' | 'index' | 'lockfile' | 'config';
  hash?: string;
  mtimeMs?: number;
  generatedAt?: string;
}

export interface ProjectModule {
  path: string;
  files: number;
  directories: number;
  role: string;
  confidence: KnowledgeConfidence;
  source: string;
}

export interface ProjectDocument {
  path: string;
  hash: string;
  mtimeMs: number;
  excerpt: string;
}

export interface ProjectKnowledge {
  root: string;
  packageName?: string;
  version?: string;
  purpose: string;
  purposeSource: string;
  ecosystem: string;
  packageManager?: string;
  frameworks: string[];
  languages: string[];
  commands: Array<{ kind: string; command: string; source: string; note?: string }>;
  scripts: Record<string, string>;
  layout: {
    sourceDirs: string[];
    entryPoints: string[];
    docFiles: string[];
    keyFiles: string[];
    topDirs: Array<{ path: string; files: number; directories: number }>;
  };
  modules: ProjectModule[];
  documents: ProjectDocument[];
  conventions: Array<{ statement: string; confidence: KnowledgeConfidence; source: string }>;
  freshness: {
    generatedAt: string;
    indexGeneratedAt: string;
    indexStale: boolean;
    indexTruncated: boolean;
    fileCount: number;
    directoryCount: number;
  };
  sources: KnowledgeSource[];
}

const MAX_DOC_BYTES = 48 * 1024;
const MAX_DOCS = 4;
const MAX_TOTAL_EXCERPT_CHARS = 2_400;
const MAX_MODULES = 12;

const NON_PROJECT_DIRS = new Set([
  '.git', '.dash', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', 'target', 'vendor',
]);

const SOURCE_DIR_NAMES = new Set([
  'src', 'source', 'lib', 'app', 'server', 'client', 'components', 'ui', 'packages', 'python', 'py',
]);

const TEST_DIR_NAMES = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'e2e']);

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function readDocument(root: string, relativePath: string): ProjectDocument | undefined {
  const absolutePath = path.join(root, relativePath);
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return undefined;
    const handle = fs.openSync(absolutePath, 'r');
    let content = '';
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_DOC_BYTES));
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytes).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
    const normalized = content.replace(/\r\n/g, '\n');
    const paragraphs = normalized
      .split(/\n\s*\n/)
      .map(paragraph => paragraph.trim())
      .filter(paragraph => paragraph && !paragraph.startsWith('```') && !paragraph.startsWith('---'));
    const prose = paragraphs.find(paragraph => !paragraph.startsWith('#') && paragraph.replace(/[#*_`>-]/g, '').trim().length > 40);
    const headings = normalized
      .split('\n')
      .filter(line => /^#{1,3}\s+/.test(line) || /^\s*[-*]\s+\S/.test(line))
      .slice(0, 12)
      .join('\n');
    const excerpt = compactText(prose ?? headings ?? normalized, 800);
    return {
      path: relativePath,
      hash: hashContent(content),
      mtimeMs: stat.mtimeMs,
      excerpt,
    };
  } catch {
    return undefined;
  }
}

function inferredRole(directory: string): { role: string; confidence: KnowledgeConfidence } {
  const name = directory.split('/').pop()?.toLowerCase() ?? directory.toLowerCase();
  if (TEST_DIR_NAMES.has(name) || /\.(test|spec)$/.test(name)) return { role: 'tests', confidence: 'inferred' };
  if (name === 'docs' || name === 'documentation') return { role: 'documentation', confidence: 'inferred' };
  if (name === 'scripts' || name === 'tools' || name === 'bin') return { role: 'tooling/scripts', confidence: 'inferred' };
  if (SOURCE_DIR_NAMES.has(name)) return { role: 'source code', confidence: 'inferred' };
  if (name === 'config' || name === 'configs') return { role: 'configuration', confidence: 'inferred' };
  return { role: 'project directory', confidence: 'inferred' };
}

function buildModules(summary: IndexSummary): ProjectModule[] {
  return summary.topDirs
    .filter(entry => entry.path && !NON_PROJECT_DIRS.has(entry.path.split('/')[0] ?? ''))
    .slice(0, MAX_MODULES)
    .map(entry => {
      const inferred = inferredRole(entry.path);
      return {
        path: entry.path,
        files: entry.files,
        directories: entry.dirs,
        role: inferred.role,
        confidence: inferred.confidence,
        source: 'workspace-index',
      };
    });
}

function buildConventions(info: ProjectInfo, documents: ProjectDocument[]): ProjectKnowledge['conventions'] {
  const conventions: ProjectKnowledge['conventions'] = [];
  if (info.packageManager) {
    conventions.push({
      statement: `Use ${info.packageManager} for Node package operations (detected from project files).`,
      confidence: 'observed',
      source: 'project-detection',
    });
  }
  if (info.verifyCommands.length) {
    conventions.push({
      statement: `Verification commands: ${info.verifyCommands.map(command => `${command.kind}=${command.command}`).join('; ')}.`,
      confidence: 'observed',
      source: 'project-detection',
    });
  }
  for (const document of documents.filter(entry => /^(AGENTS|CLAUDE|CONTRIBUTING)\.md$/i.test(entry.path))) {
    conventions.push({
      statement: `Repository guidance is documented in ${document.path}; read it before changing conventions.`,
      confidence: 'documented',
      source: document.path,
    });
  }
  return conventions;
}

export function buildProjectKnowledge(root: string): ProjectKnowledge {
  const absoluteRoot = path.resolve(root);
  const info = inspectProject(absoluteRoot);
  const summary = getIndexSummary(absoluteRoot);
  const documents: ProjectDocument[] = [];
  let excerptBudget = MAX_TOTAL_EXCERPT_CHARS;
  for (const documentPath of info.docFiles.slice(0, MAX_DOCS)) {
    const document = readDocument(absoluteRoot, documentPath);
    if (!document) continue;
    const excerpt = document.excerpt.slice(0, Math.max(0, Math.min(800, excerptBudget)));
    if (!excerpt) continue;
    documents.push({ ...document, excerpt });
    excerptBudget -= excerpt.length;
    if (excerptBudget <= 0) break;
  }

  const readme = documents.find(document => /^README(\.md)?$/i.test(document.path));
  const purpose = readme?.excerpt
    ? compactText(readme.excerpt, 500)
    : `${info.packageName ?? path.basename(absoluteRoot)} is a ${info.ecosystem} project${info.frameworks.length ? ` using ${info.frameworks.join(', ')}` : ''}.`;
  const purposeSource = readme?.path ?? 'project-detection';

  return {
    root: absoluteRoot,
    packageName: info.packageName,
    version: info.version,
    purpose,
    purposeSource,
    ecosystem: info.ecosystem,
    packageManager: info.packageManager,
    frameworks: info.frameworks,
    languages: info.languages,
    commands: info.verifyCommands.slice(0, 20).map(command => ({
      kind: command.kind,
      command: command.command.slice(0, 400),
      source: command.source,
      note: command.note?.slice(0, 200),
    })),
    scripts: Object.fromEntries(
      Object.entries(info.scripts)
        .slice(0, 30)
        .map(([name, script]) => [name, script.slice(0, 400)]),
    ),
    layout: {
      sourceDirs: info.sourceDirs,
      entryPoints: info.entryPoints,
      docFiles: info.docFiles,
      keyFiles: summary.keyFiles.slice(0, 30),
      topDirs: summary.topDirs.slice(0, MAX_MODULES).map(entry => ({
        path: entry.path,
        files: entry.files,
        directories: entry.dirs,
      })),
    },
    modules: buildModules(summary),
    documents,
    conventions: buildConventions(info, documents),
    freshness: {
      generatedAt: new Date().toISOString(),
      indexGeneratedAt: summary.generatedAt,
      indexStale: summary.stale,
      indexTruncated: summary.truncated,
      fileCount: summary.fileCount,
      directoryCount: summary.directoryCount,
    },
    sources: [
      { path: 'workspace-index', kind: 'index', generatedAt: summary.generatedAt },
      ...info.manifests.map(manifest => ({ path: manifest, kind: 'manifest' as const })),
      ...info.lockfiles.map(lockfile => ({ path: lockfile, kind: 'lockfile' as const })),
      ...documents.map(document => ({
        path: document.path,
        kind: 'document' as const,
        hash: document.hash,
        mtimeMs: document.mtimeMs,
      })),
    ],
  };
}

export function compactProjectKnowledge(knowledge: ProjectKnowledge): Record<string, unknown> {
  return {
    packageName: knowledge.packageName,
    version: knowledge.version,
    purpose: knowledge.purpose,
    purposeSource: knowledge.purposeSource,
    ecosystem: knowledge.ecosystem,
    packageManager: knowledge.packageManager,
    frameworks: knowledge.frameworks,
    sourceDirs: knowledge.layout.sourceDirs,
    entryPoints: knowledge.layout.entryPoints,
    scriptNames: Object.keys(knowledge.scripts),
    commands: knowledge.commands,
    documentSources: knowledge.documents.map(document => ({ path: document.path, hash: document.hash.slice(0, 12) })),
    modules: knowledge.modules.slice(0, 8).map(module => ({ path: module.path, files: module.files, role: module.role })),
    freshness: knowledge.freshness,
  };
}
