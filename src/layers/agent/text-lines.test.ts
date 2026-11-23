import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertTextFile, readLineRange, scanFileLines } from './text-lines';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-text-lines-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('text line ranges', () => {
  it('returns a bounded page with total line count and next offset', async () => {
    const file = path.join(root, 'lines.txt');
    await fs.writeFile(file, 'one\ntwo\nthree\nfour\nfive\n', 'utf8');

    const first = await readLineRange(file, 1, 2);
    expect(first.lines.map(line => line.text)).toEqual(['one', 'two']);
    expect(first.totalLines).toBe(5);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(3);

    const second = await readLineRange(file, 2, 10);
    expect(second.lines.map(line => line.text)).toEqual(['two', 'three', 'four', 'five']);
    expect(second.totalLines).toBe(5);
    expect(second.truncated).toBe(false);
    expect(second.nextOffset).toBeNull();
  });

  it('handles offsets past the end and scans without materializing lines', async () => {
    const file = path.join(root, 'short.txt');
    await fs.writeFile(file, 'only\n', 'utf8');

    const past = await readLineRange(file, 10, 5);
    expect(past.lines).toEqual([]);
    expect(past.totalLines).toBe(1);
    expect(past.truncated).toBe(false);

    const scanned = await scanFileLines(file, () => undefined);
    expect(scanned.lineCount).toBe(1);
  });

  it('rejects binary files', async () => {
    const file = path.join(root, 'binary.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3]));
    await expect(assertTextFile(file)).rejects.toThrow('not a UTF-8 text file');
  });
});
