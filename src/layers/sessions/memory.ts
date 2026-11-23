import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MEMORY_FILE = path.join(os.homedir(), '.dash', 'memory.md');
export const MAX_MEMORY_BYTES = 32 * 1024;

export function readAgentMemory(filePath = MEMORY_FILE): string {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, MAX_MEMORY_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function writeAgentMemory(content: string, filePath = MEMORY_FILE): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) {
    throw new Error(`Memory exceeds the ${MAX_MEMORY_BYTES}-byte limit.`);
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Permission tightening may be unsupported. */ }

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temporaryPath, 0o600); } catch { /* Permission tightening may be unsupported. */ }
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Permission tightening may be unsupported. */ }
}
