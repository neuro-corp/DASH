import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '..', 'bin', 'dash.js');

function run(args: string[]) {
  return spawnSync('node', [binPath, ...args], { encoding: 'utf8', timeout: 5000 });
}

describe('CLI args handling', () => {
  it('dash --version prints version and exits without UI', () => {
    const result = run(['--version']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dash version \d+\.\d+\.\d+/);
  });

  it('dash -v prints version and exits without UI', () => {
    const result = run(['-v']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dash version \d+\.\d+\.\d+/);
  });

  it('dash --help prints help and exits without UI', () => {
    const result = run(['--help']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--version');
  });

  it('dash -h prints help and exits without UI', () => {
    const result = run(['-h']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});
