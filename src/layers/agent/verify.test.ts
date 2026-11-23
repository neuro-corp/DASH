import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runChecks, checkSyntax, runTestsWithPattern, getLatestCheckResults, validCheckKinds, storeCheckResults, hasVerifiableChanges, isPreExistingFailure } from './verify';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-verify-'));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('verification layer', () => {
  it('only treats files the project language covers as verifiable', () => {
    expect(hasVerifiableChanges(['html/script.py'], 'bun')).toBe(false);
    expect(hasVerifiableChanges(['src/index.ts'], 'bun')).toBe(true);
    expect(hasVerifiableChanges(['html/index.html'], 'bun')).toBe(false);
    expect(hasVerifiableChanges(['app/main.py'], 'python')).toBe(true);
    expect(hasVerifiableChanges(['app/main.py'], 'rust')).toBe(false);
    expect(hasVerifiableChanges(['lib/main.dart'], 'flutter')).toBe(true);
    expect(hasVerifiableChanges(['lib/main.dart'], 'dart')).toBe(true);
  });

  it('attributes failing tests to the files named in their output', () => {
    const result = {
      name: 'test',
      kind: 'test' as const,
      method: 'fake',
      status: 'fail' as const,
      failure: 'CLI args handling > dash --version',
      output: 'src/cliArgs.test.ts(17,27): error: expected 0',
    };
    expect(isPreExistingFailure(result, ['html/script.py'])).toBe(true);
    expect(isPreExistingFailure(result, ['src/cliArgs.test.ts'])).toBe(false);
  });

  it('validates JSON syntax of changed files', async () => {
    await fs.writeFile(path.join(projectRoot, 'config.json'), '{ "broken": ,', 'utf8');
    storeCheckResults([]);
    const results = await runChecks({ root: projectRoot, kinds: ['syntax'], files: ['config.json'] });
    const syntax = results.find(result => result.name === 'syntax:config.json');
    expect(syntax?.status).toBe('fail');
    expect(getLatestCheckResults().length).toBe(results.length);
  });

  it('passes valid JSON syntax checks and flags missing files as blocked', async () => {
    const results = await checkSyntax(projectRoot, ['package.json']);
    expect(results[0]?.status).toBe('blocked');
    await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"v"}', 'utf8');
    const valid = await checkSyntax(projectRoot, ['package.json']);
    expect(valid[0]?.status).toBe('pass');
  });

  it('returns skipped for kinds the project has no command for', async () => {
    const results = await runChecks({ root: projectRoot, kinds: ['lint', 'typecheck', 'test'] });
    expect(results.map(result => result.status)).toEqual(['skipped', 'skipped', 'skipped']);
    for (const result of results) {
      expect(result.command).toBeUndefined();
      expect(result.summary).toContain('No');
    }
  });

  it('runs a discovered test command and reports failure with error summary', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'echo failing-tests && exit 3' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'package-lock.json'), '{}', 'utf8');
    const results = await runTestsWithPattern(projectRoot);
    const test = results[0];
    expect(test?.command).toBe('npm run test');
    expect(test?.status).toBe('fail');
    expect(test?.exitCode).toBe(3);
  });

  it('runs pass checks using npm scripts via discovered package manager', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'echo tests-pass' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'bun.lock'), '', 'utf8');
    const results = await runTestsWithPattern(projectRoot);
    expect(results[0]?.status).toBe('pass');
    expect(results[0]?.command).toBe('bun run test');
  });

  it('falls back to bun test for projects without a test script', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'n' }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'bun.lock'), '', 'utf8');
    await fs.mkdir(path.join(projectRoot, 'test'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'test', 'passing.test.ts'), 'import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n', 'utf8');
    const results = await runTestsWithPattern(projectRoot, undefined, 60_000);
    expect(results[0]?.command).toBe('bun test');
    expect(results[0]?.status).toBe('pass');
  });

  it('announces where the test command could not run (missing runner)', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'definitely-not-a-real-command-xyz --run' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'package-lock.json'), '{}', 'utf8');
    const results = await runTestsWithPattern(projectRoot, undefined, 60_000);
    expect(results[0]?.status).toBe('fail');
    expect((results[0]?.failure ?? '').length).toBeGreaterThan(0);
  });

  it('respects cancellation', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'c', scripts: { test: 'sleep 10' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'bun.lock'), '', 'utf8');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const results = await runTestsWithPattern(projectRoot, undefined, 60_000, controller.signal);
    const test = results[0];
    expect(test && (test.status === 'blocked' || test.failure)).toBeTruthy();
  });

  it('validates requested check kinds', () => {
    expect(validCheckKinds(['typecheck', 'bogus'])).toEqual(['typecheck']);
    expect(validCheckKinds(undefined)).toEqual([]);
  });

  it('runs long commands up to a timeout and reports timedOut', async () => {
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 's', scripts: { test: 'sleep 5' } }), 'utf8');
    await fs.writeFile(path.join(projectRoot, 'bun.lock'), '', 'utf8');
    const results = await runTestsWithPattern(projectRoot, undefined, 1500);
    const test = results[0];
    expect(['fail', 'blocked']).toContain(test?.status as string);
  });
});
