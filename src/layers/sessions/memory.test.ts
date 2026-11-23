import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_MEMORY_BYTES, readAgentMemory, writeAgentMemory } from './memory';

let directory = '';
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = '';
});

function getMemoryPath() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-memory-test-'));
  return path.join(directory, 'private', 'memory.md');
}

describe('private agent memory', () => {
  it('reads an empty store and atomically persists memory content', () => {
    const filePath = getMemoryPath();
    expect(readAgentMemory(filePath)).toBe('');
    writeAgentMemory('Preferred style: concise answers.', filePath);
    expect(readAgentMemory(filePath)).toBe('Preferred style: concise answers.');
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects memory that exceeds the storage limit', () => {
    const filePath = getMemoryPath();
    expect(() => writeAgentMemory('x'.repeat(MAX_MEMORY_BYTES + 1), filePath)).toThrow('exceeds');
  });
});
