import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runShellCommand, buildShellCommand, killProcessTree } from '../command/shell';
import { inspectProject } from './project';
import { taskStatePath } from './taskstate';

export type CheckKind = 'syntax' | 'lint' | 'typecheck' | 'test' | 'build';

export interface CheckResult {
  name: string;
  kind: CheckKind;
  command?: string;
  method: string;
  status: 'pass' | 'fail' | 'skipped' | 'blocked';
  exitCode?: number;
  durationMs?: number;
  started?: string;
  summary?: string;
  failure?: string;
  output?: string;
  truncated?: boolean;
  timedOut?: boolean;
  files?: string[];
  /** The check was already failing before this task touched any changed file. */
  preExisting?: boolean;
}

const DEFAULT_CHECK_TIMEOUT_MS = 180_000;
const MAX_CHECK_OUTPUT = 20_000;

/** Static assets have no project-wide check that can meaningfully cover them. */
const NON_CODE_ASSET_PATTERN = /\.(?:html?|css|scss|sass|less|styl|md|markdown|mdx|txt|rst|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|wav|mp4|mov|webm|pdf)$/i;

/**
 * Extensions the project's own checks can cover. A .py script dropped into a
 * TypeScript repository must not trigger `tsc`/`bun test`, and vice versa.
 */
const ECOSYSTEM_SOURCE_PATTERN: Record<string, RegExp> = {
  node: /\.(?:[cm]?[jt]sx?|json|jsonc)$/i,
  bun: /\.(?:[cm]?[jt]sx?|json|jsonc)$/i,
  python: /\.(?:py|pyi|toml|cfg)$/i,
  rust: /\.rs$/i,
  go: /\.go$/i,
  php: /\.php$/i,
  ruby: /\.rb$/i,
  dart: /\.dart$/i,
  flutter: /\.dart$/i,
};

const MENTIONED_FILE_PATTERN = /[A-Za-z0-9_$@./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|dart|json|jsonc|ya?ml|toml|css|scss|less|html?|md)\b/gi;

/**
 * Check kinds whose failure output can be attributed to the files it names.
 * `test` belongs here too: a test runner names the failing test file, and that
 * is how an unrelated pre-existing test failure is detected.
 */
const ATTRIBUTABLE_KINDS = new Set<CheckKind>(['syntax', 'typecheck', 'lint', 'test', 'build']);

export function isAutoVerifiableChange(file: string, ecosystem?: string): boolean {
  const normalized = file.replace(/\\/g, '/').trim();
  if (!normalized) return false;
  const pattern = ecosystem ? ECOSYSTEM_SOURCE_PATTERN[ecosystem] : undefined;
  if (pattern) return pattern.test(normalized);
  return !NON_CODE_ASSET_PATTERN.test(normalized);
}

export function hasVerifiableChanges(files: readonly string[], ecosystem?: string): boolean {
  return files.some(file => isAutoVerifiableChange(file, ecosystem));
}

function normalizedMatches(file: string, changedFiles: readonly string[]): boolean {
  const normalized = file.replace(/\\/g, '/');
  return changedFiles.some(changed => {
    const target = changed.replace(/\\/g, '/');
    return normalized === target
      || normalized.endsWith(`/${target}`)
      || target.endsWith(`/${normalized}`);
  });
}

/**
 * A failing check is treated as pre-existing when it can only be attributed to
 * files this task did not change. This keeps unrelated repository failures from
 * turning a small task into an endless repair loop. When the output names no
 * files at all (or the check kind cannot be attributed), it stays relevant.
 */
export function isPreExistingFailure(result: CheckResult, changedFiles: readonly string[]): boolean {
  if (result.status !== 'fail') return false;
  if (result.kind === 'syntax' && result.files?.length) {
    return !result.files.some(file => normalizedMatches(file, changedFiles));
  }
  if (!ATTRIBUTABLE_KINDS.has(result.kind)) return false;
  const text = `${result.failure ?? ''}\n${result.output ?? ''}`;
  const mentioned = text.match(MENTIONED_FILE_PATTERN) ?? [];
  if (mentioned.length === 0) return false;
  return !mentioned.some(file => normalizedMatches(file, changedFiles));
}

export function annotateVerificationResults(
  results: CheckResult[],
  changedFiles: readonly string[],
): CheckResult[] {
  return results.map(result => {
    if (result.preExisting || result.status !== 'fail') return result;
    return isPreExistingFailure(result, changedFiles) ? { ...result, preExisting: true } : result;
  });
}

/** Merge a new round of results into earlier results, replacing matching kinds. */
export function mergeVerificationResults(previous: CheckResult[], next: CheckResult[]): CheckResult[] {
  const replacedKinds = new Set(next.map(result => result.kind));
  return [...previous.filter(result => !replacedKinds.has(result.kind)), ...next];
}

let latestResults: CheckResult[] = [];

export function getLatestCheckResults(): CheckResult[] {
  return [...latestResults];
}

export function storeCheckResults(results: CheckResult[]): void {
  latestResults = results;
}

function summarizeFailure(shellResult: { stdout: string; stderr: string }): string {
  const text = `${shellResult.stderr || ''}\n${shellResult.stdout || ''}`;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const failureLines = lines.filter(line => /error|failed|✕|fail|exception|cannot|invalid|unexpected|assert/i.test(line));
  const selected = failureLines.length ? failureLines : lines;
  return selected.slice(0, 10).join('\n').slice(0, 1500);
}

async function runCommandCheck(
  name: string,
  kind: CheckKind,
  command: string,
  source: string,
  root: string,
  timeoutMs: number,
  signal?: AbortSignal,
  files?: string[],
): Promise<CheckResult> {
  const shellResult = await runShellCommand(command, {
    cwd: root,
    timeoutMs,
    signal,
    maxOutput: MAX_CHECK_OUTPUT,
  });
  const passed = shellResult.exitCode === 0 && !shellResult.cancelled;
  if (passed) {
    return {
      name,
      kind,
      command,
      method: source,
      status: 'pass',
      exitCode: shellResult.exitCode,
      durationMs: shellResult.durationMs,
      started: shellResult.started,
      summary: `${name} passed (exit ${shellResult.exitCode}) in ${Math.round(shellResult.durationMs / 1000)}s.`,
    };
  }
  return {
    name,
    kind,
    command,
    method: source,
    status: shellResult.cancelled ? 'blocked' : 'fail',
    exitCode: shellResult.exitCode,
    durationMs: shellResult.durationMs,
    started: shellResult.started,
    summary: `${name} failed (exit ${shellResult.exitCode}).`,
    failure: summarizeFailure(shellResult),
    output: shellResult.output,
    truncated: shellResult.truncated,
    timedOut: shellResult.timedOut,
    files,
  };
}

function discoverChangedFiles(root: string, explicit?: string[]): string[] {
  if (explicit?.length) {
    return explicit
      .map(file => path.relative(root, path.resolve(root, file)))
      .map(relative => relative.replace(/\\/g, '/'));
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(taskStatePath(root), 'utf8'));
    const changedFiles = parsed && typeof parsed === 'object'
      ? (parsed as { changedFiles?: unknown }).changedFiles
      : undefined;
    if (Array.isArray(changedFiles)) {
      return changedFiles.filter((file): file is string => typeof file === 'string');
    }
  } catch {
    return [];
  }
  return [];
}

export async function checkSyntax(root: string, files: string[], signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const relative of files.slice(0, 40)) {
    if (signal?.aborted) {
      results.push({ name: `syntax:${relative}`, kind: 'syntax', method: 'json-parse', status: 'blocked', summary: 'Cancelled before checking.', files: [relative] });
      continue;
    }
    if (!/\.(json|jsonc)$/i.test(relative)) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, relative), 'utf8');
    } catch {
      results.push({ name: `syntax:${relative}`, kind: 'syntax', method: 'json-parse', status: 'blocked', summary: 'File could not be read.', files: [relative] });
      continue;
    }
    try {
      JSON.parse(content);
      results.push({ name: `syntax:${relative}`, kind: 'syntax', method: 'json-parse', status: 'pass', summary: 'Valid JSON.', files: [relative] });
    } catch (error) {
      results.push({
        name: `syntax:${relative}`,
        kind: 'syntax',
        method: 'json-parse',
        status: 'fail',
        failure: error instanceof Error ? error.message : String(error),
        summary: 'Invalid JSON.',
        files: [relative],
      });
    }
  }
  return results;
}

const ALL_KINDS: CheckKind[] = ['syntax', 'typecheck', 'lint', 'test', 'build'];

export function validCheckKinds(kinds: unknown): CheckKind[] {
  if (!Array.isArray(kinds) || kinds.length === 0) return [];
  const requested = kinds.filter((kind): kind is CheckKind => typeof kind === 'string' && (ALL_KINDS as string[]).includes(kind));
  return Array.from(new Set(requested));
}

export async function runChecks(options: {
  root: string;
  kinds?: CheckKind[];
  timeoutMs?: number;
  signal?: AbortSignal;
  files?: string[];
}): Promise<CheckResult[]> {
  const root = path.resolve(options.root);
  const kinds = options.kinds?.length ? options.kinds : ALL_KINDS.filter(kind => kind !== 'build');
  const info = inspectProject(root);
  const files = discoverChangedFiles(root, options.files);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const results: CheckResult[] = [];

  if (kinds.includes('syntax') && files.length) {
    results.push(...await checkSyntax(root, files, options.signal));
  }
  for (const kind of kinds.filter(candidate => candidate !== 'syntax')) {
    if (options.signal?.aborted) {
      results.push({ name: kind, kind, method: 'shell', status: 'blocked', summary: 'Cancelled before running.' });
      continue;
    }
    const verifyCommand = info.verifyCommands.find(candidate => candidate.kind === kind);
    if (!verifyCommand) {
      results.push({
        name: kind,
        kind,
        method: 'project-discovery',
        status: 'skipped',
        summary: `No ${kind} command detected for this project (ecosystem: ${info.ecosystem}). Nothing was run; do not assume it passed.`,
      });
      continue;
    }
    try {
      results.push(await runCommandCheck(kind, kind, verifyCommand.command, verifyCommand.source, root, timeoutMs, options.signal, files));
    } catch (error) {
      results.push({
        name: kind,
        kind,
        command: verifyCommand.command,
        method: verifyCommand.source,
        status: 'blocked',
        summary: `Could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  storeCheckResults(results);
  return results;
}

export async function runTestsWithPattern(
  root: string,
  pattern?: string,
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const info = inspectProject(root);
  const verifyCommand = info.verifyCommands.find(candidate => candidate.kind === 'test');
  if (!verifyCommand) {
    const result: CheckResult = {
      name: 'test',
      kind: 'test',
      method: 'project-discovery',
      status: 'skipped',
      summary: 'No test command detected for this project type. Nothing was run; do not assume tests passed.',
    };
    storeCheckResults([...getLatestCheckResults().filter(entry => entry.kind !== 'test'), result]);
    return [result];
  }
  const command = pattern?.trim() ? `${verifyCommand.command} ${pattern.trim()}` : verifyCommand.command;
  try {
    const result = await runCommandCheck('test', 'test', command, verifyCommand.source, root, timeoutMs, signal);
    storeCheckResults([result]);
    return [result];
  } catch (error) {
    return [{
      name: 'test',
      kind: 'test',
      command,
      method: verifyCommand.source,
      status: 'blocked',
      summary: `Could not run: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}

const READY_HINT_RE = /listening|started server|ready in|localhost|127\.0\.0\.1|0\.0\.0\.0|running on|http:\/\/|https:\/\//i;

export interface RuntimeResult extends CheckResult { kind: 'syntax' }

export async function verifyRuntime(
  root: string,
  command?: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<RuntimeResult> {
  const info = inspectProject(root);
  let runtimeCommand = command?.trim();
  if (!runtimeCommand) {
    const start = info.scripts['start'];
    const dev = info.scripts['dev'];
    if (typeof start === 'string' && /serve|listen|server|start/i.test(start)) runtimeCommand = `${info.runnerBase} start`;
    else if (typeof dev === 'string' && /serve|listen|server|dev/i.test(dev)) runtimeCommand = `${info.runnerBase} dev`;
  }
  if (!runtimeCommand) {
    return {
      name: 'runtime',
      kind: 'syntax',
      method: 'startup-probe',
      status: 'skipped',
      summary: 'No start or dev serving script detected; runtime check was skipped, not passed.',
    };
  }
  if (signal?.aborted) {
    return { name: 'runtime', kind: 'syntax', command: runtimeCommand, method: 'startup-probe', status: 'blocked', summary: 'Cancelled before startup.' };
  }

  const absoluteRoot = path.resolve(root);
  const { file, args } = buildShellCommand(runtimeCommand);
  let child: import('node:child_process').ChildProcess;
  try {
    child = spawn(file, args, { cwd: absoluteRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return {
      name: 'runtime',
      kind: 'syntax',
      command: runtimeCommand,
      method: 'startup-probe',
      status: 'blocked',
      summary: `Could not start process: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const startedClock = Date.now();
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { if (output.length < 12_000) output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { if (output.length < 12_000) output += chunk.toString(); });

  let exitCode: number | null = null;
  let crashedEarly = false;
  child.once('exit', code => {
    exitCode = code;
    if (Date.now() - startedClock < 2500 && code !== 0 && code !== null) crashedEarly = true;
  });
  const abortHandler = () => killProcessTree(child);
  signal?.addEventListener('abort', abortHandler, { once: true });

  const settled = await new Promise<{ ready: boolean; exitCode: number | null }>(resolve => {
    const startedTime = Date.now();
    const interval = setInterval(() => {
      if (exitCode !== null) {
        clearInterval(interval);
        resolve({ ready: false, exitCode });
        return;
      }
      if (signal?.aborted) {
        clearInterval(interval);
        resolve({ ready: false, exitCode: child.exitCode ?? null });
        return;
      }
      if (Date.now() - startedTime >= timeoutMs) {
        clearInterval(interval);
        resolve({ ready: true, exitCode: null });
      }
    }, 250);
  });

  killProcessTree(child);
  signal?.removeEventListener('abort', abortHandler);

  if (signal?.aborted) {
    return {
      name: 'runtime', kind: 'syntax', command: runtimeCommand, method: 'startup-probe', status: 'blocked',
      summary: 'Cancelled during runtime probe.',
      output: output.slice(0, MAX_CHECK_OUTPUT) || undefined,
    };
  }
  if (settled.exitCode !== null && crashedEarly) {
    return {
      name: 'runtime', kind: 'syntax', command: runtimeCommand, method: 'startup-probe', status: 'fail',
      exitCode: settled.exitCode,
      durationMs: Date.now() - startedClock,
      summary: `Runtime process exited during startup (code ${settled.exitCode}).`,
      failure: output.split(/\r?\n/).filter(Boolean).slice(-8).join('\n').slice(0, 1500),
      output: output.slice(0, MAX_CHECK_OUTPUT),
    };
  }
  if (settled.ready && READY_HINT_RE.test(output)) {
    return {
      name: 'runtime', kind: 'syntax', command: runtimeCommand, method: 'startup-probe', status: 'pass',
      durationMs: Date.now() - startedClock,
      summary: 'Process started, stayed alive for the full probe window, and reported a ready/listening state.',
      output: output.slice(0, MAX_CHECK_OUTPUT) || undefined,
    };
  }
  if (settled.ready) {
    return {
      name: 'runtime', kind: 'syntax', command: runtimeCommand, method: 'startup-probe', status: 'pass',
      durationMs: Date.now() - startedClock,
      summary: 'Process started and stayed alive for the full probe window (no explicit ready signal found).',
      output: output.slice(0, MAX_CHECK_OUTPUT) || undefined,
      exitCode: undefined,
    };
  }
  return {
    name: 'runtime', kind: 'syntax', command: runtimeCommand, method: 'startup-probe', status: 'blocked',
    exitCode: settled.exitCode ?? undefined,
    durationMs: Date.now() - startedClock,
    summary: `Process exited during probe (code ${settled.exitCode ?? 'unknown'}).`,
    output: output.slice(0, MAX_CHECK_OUTPUT) || undefined,
  };
}
