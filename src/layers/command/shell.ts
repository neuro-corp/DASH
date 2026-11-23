import { spawn } from 'node:child_process';

export interface ShellRunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutput?: number;
  onStatus?: (message: string) => void;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  started: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 40_000;

export function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function buildShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: 'sh', args: ['-c', command] };
}

export async function runShellCommand(command: string, options: ShellRunOptions): Promise<ShellResult> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Command cannot be empty.');
  const started = new Date().toISOString();
  const startClock = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const { file, args } = buildShellCommand(trimmed);
  const child = spawn(file, args, {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  const append = (target: 'stdout' | 'stderr', chunk: string) => {
    const current = target === 'stdout' ? stdout : stderr;
    if (current.length >= maxOutput) {
      truncated = true;
      return;
    }
    const capped = chunk.slice(0, maxOutput - current.length);
    if (capped.length < chunk.length) truncated = true;
    if (target === 'stdout') stdout += capped;
    else stderr += capped;
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk.toString()));

  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    options.onStatus?.(`Command timed out after ${Math.round(timeoutMs / 1000)}s; terminating.`);
    killProcessTree(child);
  }, timeoutMs);
  const abort = () => {
    cancelled = true;
    killProcessTree(child);
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    return {
      exitCode,
      stdout,
      stderr,
      output: (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).slice(0, maxOutput),
      truncated,
      timedOut,
      cancelled,
      started,
      durationMs: Date.now() - startClock,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
