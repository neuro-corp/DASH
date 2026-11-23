import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as readline from 'node:readline';

export interface FileVersion {
  size: number;
  mtimeMs: number;
}

export interface ScannedLine {
  line: number;
  text: string;
}

export interface LineRangeResult {
  startLine: number;
  endLine: number;
  totalLines: number | null;
  truncated: boolean;
  nextOffset: number | null;
  lines: ScannedLine[];
  bytesReturned: number;
  bytesScanned: number;
}

export const DEFAULT_READ_LIMIT = 200;
export const MAX_READ_LIMIT = 2_000;
export const MAX_FULL_READ_BYTES = 512 * 1024;
const SMALL_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export async function getFileVersion(filePath: string): Promise<FileVersion> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Path is not a file.');
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

export async function isProbablyBinary(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function assertTextFile(filePath: string): Promise<FileVersion> {
  const version = await getFileVersion(filePath);
  if (await isProbablyBinary(filePath)) throw new Error('Path is not a UTF-8 text file.');
  return version;
}

export function hashText(value: string | Buffer): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

interface StreamOptions {
  maxLines?: number;
  countToEnd?: boolean;
  onLine: (line: ScannedLine) => boolean | void;
}

async function streamLines(filePath: string, options: StreamOptions): Promise<{ lastLine: number; bytesScanned: number; stopped: boolean }> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let lastLine = 0;
  let bytesScanned = 0;
  let stopped = false;
  try {
    for await (const text of reader) {
      lastLine += 1;
      bytesScanned += Buffer.byteLength(text, 'utf8') + 1;
      const shouldContinue = options.onLine({ line: lastLine, text });
      if (shouldContinue === false) {
        stopped = true;
        break;
      }
      if (options.maxLines !== undefined && lastLine >= options.maxLines && !options.countToEnd) {
        stopped = true;
        break;
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return { lastLine, bytesScanned, stopped };
}

export async function readLineRange(
  filePath: string,
  offset: number,
  limit: number = DEFAULT_READ_LIMIT,
): Promise<LineRangeResult> {
  const version = await assertTextFile(filePath);
  const startLine = Math.max(1, Math.trunc(offset));
  const pageSize = Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(limit)));
  const countToEnd = version.size <= SMALL_FILE_BYTES;
  const selected: ScannedLine[] = [];
  let bytesReturned = 0;
  let sawMore = false;

  const scan = await streamLines(filePath, {
    countToEnd,
    onLine: line => {
      if (line.line < startLine) return;
      if (selected.length < pageSize) {
        selected.push(line);
        bytesReturned += Buffer.byteLength(line.text, 'utf8') + 1;
        return;
      }
      sawMore = true;
      return countToEnd ? undefined : false;
    },
  });

  const last = selected[selected.length - 1];
  const endLine = last ? last.line : startLine - 1;
  const totalLines = countToEnd ? scan.lastLine : null;
  const truncated = sawMore || (totalLines !== null && endLine < totalLines);
  return {
    startLine,
    endLine,
    totalLines,
    truncated,
    nextOffset: truncated ? endLine + 1 : null,
    lines: selected,
    bytesReturned,
    bytesScanned: scan.bytesScanned,
  };
}

export async function countLines(filePath: string): Promise<number> {
  const scan = await streamLines(filePath, { onLine: () => undefined });
  return scan.lastLine;
}

export async function scanFileLines(
  filePath: string,
  onLine: (line: ScannedLine) => boolean | void,
): Promise<{ lineCount: number; bytesScanned: number; stopped: boolean }> {
  const scan = await streamLines(filePath, { onLine });
  return { lineCount: scan.lastLine, bytesScanned: scan.bytesScanned, stopped: scan.stopped };
}
