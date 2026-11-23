import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskTracker, taskStatePath } from './taskstate';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-taskstate-'));
});

afterEach(async () => {
  await fs.rm(taskStatePath(workspaceRoot), { force: true });
  await fs.rm(taskStatePath(workspaceRoot, 'session-a'), { force: true });
  await fs.rm(taskStatePath(workspaceRoot, 'session-b'), { force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('task state', () => {
  it('persists steps, changed files, and verification across tracker instances', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setObjective('Build the feature');
    tracker.setSteps([
      { id: 's1', title: 'Edit code', status: 'in-progress' },
      { id: 's2', title: 'Verify', status: 'pending', dependsOn: ['s1'] },
    ]);
    tracker.setVerification([{ name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'pass' }]);
    await tracker.prepareChange(path.join(workspaceRoot, 'src', 'a.ts'), workspaceRoot);
    await fs.mkdir(path.dirname(path.join(workspaceRoot, 'src', 'a.ts')), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src', 'a.ts'), 'changed', 'utf8');

    const reloaded = new TaskTracker(workspaceRoot);
    expect(reloaded.getObjective()).toBe('Build the feature');
    expect(reloaded.getChangedFiles()).toEqual(['src/a.ts']);
    expect(reloaded.getStep('s2')?.status).toBe('pending');
    expect(reloaded.hasPendingWork()).toBe(true);
    expect(reloaded.nextStep()?.id).toBe('s1');
  });

  it('clears per-run verification and resets stale plans for a new objective', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setObjective('Task A');
    tracker.setSteps([{ id: 's1', title: 'Step', status: 'pending' }]);
    await tracker.prepareChange(path.join(workspaceRoot, 'src', 'a.ts'), workspaceRoot);
    tracker.setVerification([{ name: 'test', kind: 'test', method: 'fake', status: 'fail', failure: 'boom' }]);

    const same = tracker.beginRun('Task A');
    expect(same.resumed).toBe(true);
    expect(tracker.getVerification()).toEqual([]);
    expect(tracker.getSteps()).toHaveLength(1);
    expect(tracker.getChangedFiles()).toEqual(['src/a.ts']);

    const next = tracker.beginRun('Task B');
    expect(next.resumed).toBe(false);
    expect(tracker.getSteps()).toEqual([]);
    expect(tracker.getChangedFiles()).toEqual([]);
    expect(tracker.getVerification()).toEqual([]);
  });

  it('invalidates verification evidence after any further write, including the same file', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    await tracker.prepareChange(path.join(workspaceRoot, 'src', 'b.ts'), workspaceRoot);
    tracker.setVerification([{ name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'pass' }]);
    expect(tracker.getVerification()).toHaveLength(1);

    await tracker.prepareChange(path.join(workspaceRoot, 'src', 'b.ts'), workspaceRoot);
    expect(tracker.getChangedFiles()).toEqual(['src/b.ts']);
    expect(tracker.getVerification()).toEqual([]);
  });

  it('ignores pre-existing verification failures when deciding task success', () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setVerification([
      { name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'fail', preExisting: true },
      { name: 'test', kind: 'test', method: 'fake', status: 'pass' },
    ]);
    expect(tracker.hasFailedCheck()).toBe(false);
    expect(tracker.getUnresolvedChecks()).toEqual([]);
    expect(tracker.allVerificationPassed()).toBe(true);
  });


  it('computes the next actionable step by dependencies', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setSteps([
      { id: 'a', title: 'first' },
      { id: 'b', title: 'second', dependsOn: ['a'] },
      { id: 'c', title: 'third', dependsOn: ['b'] },
    ]);
    expect(tracker.nextStep()?.id).toBe('a');
    tracker.completeStep('a');
    expect(tracker.nextStep()?.id).toBe('b');
    tracker.completeStep('b');
    expect(tracker.nextStep()?.id).toBe('c');
    tracker.completeStep('c');
    expect(tracker.nextStep()).toBeUndefined();
    expect(tracker.hasPendingWork()).toBe(false);
  });

  it('checkpoints files before modification and restores them on rollback', async () => {
    const target = path.join(workspaceRoot, 'src', 'roll.ts');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'const original = true;', 'utf8');
    const tracker = new TaskTracker(workspaceRoot);
    await tracker.prepareChange(target, workspaceRoot);
    await fs.writeFile(target, 'const replaced = true;', 'utf8');
    expect(tracker.checkpointCount()).toBe(1);

    const restored = await tracker.rollbackCheckpoints(workspaceRoot);
    expect(restored).toEqual(['src/roll.ts']);
    expect(await fs.readFile(target, 'utf8')).toBe('const original = true;');
  });

  it('creates checkpoints for files that did not exist and removes them on rollback', async () => {
    const target = path.join(workspaceRoot, 'new-file.ts');
    const tracker = new TaskTracker(workspaceRoot);
    await tracker.prepareChange(target, workspaceRoot);
    await fs.writeFile(target, 'brand new', 'utf8');
    await tracker.rollbackCheckpoints(workspaceRoot);
    expect(await fs.stat(target).catch(() => null)).toBeNull();
  });

  it('records history with outcomes and honors limits', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.recordHistory('did a thing', 'with detail', 'ok');
    tracker.recordHistory('failed a thing', 'because x', 'fail');
    const history = tracker.getHistory();
    expect(history.at(-2)?.outcome).toBe('ok');
    expect(history.at(-1)?.outcome).toBe('fail');
    expect(tracker.summarize()).toContain('ok');
  });

  it('maps steps to UI todo status', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setSteps([
      { id: 'a', title: 'one' },
      { id: 'b', title: 'two', status: 'in-progress' },
      { id: 'c', title: 'three', status: 'completed' },
      { id: 'd', title: 'four', status: 'failed' },
    ]);
    const todos = tracker.toTodos();
    expect(todos.map(todo => todo.status)).toEqual(['not-started', 'in-progress', 'completed', 'in-progress']);
    expect(todos.map(todo => todo.id)).toEqual([1, 2, 3, 4]);
  });

  it('isolates persisted task state by session', async () => {
    const first = new TaskTracker(workspaceRoot, 'session-a');
    first.setObjective('Session A objective');
    first.setSteps([{ id: 'a', title: 'A step', status: 'in-progress' }]);
    first.recordHistory('did A', 'detail', 'ok');

    const second = new TaskTracker(workspaceRoot, 'session-b');
    expect(second.getObjective()).toBe('');
    second.setObjective('Session B objective');

    const firstReloaded = new TaskTracker(workspaceRoot, 'session-a');
    expect(firstReloaded.getObjective()).toBe('Session A objective');
    expect(firstReloaded.getStep('a')?.status).toBe('in-progress');
    expect(new TaskTracker(workspaceRoot, 'session-b').getObjective()).toBe('Session B objective');
    expect(taskStatePath(workspaceRoot, 'session-a')).not.toBe(taskStatePath(workspaceRoot, 'session-b'));
  });

  it('distinguishes verified evidence from skipped, failed, and blocked checks', () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setVerification([{ name: 'test', kind: 'test', method: 'fake', status: 'skipped' }]);
    expect(tracker.hasPassingEvidence()).toBe(false);
    expect(tracker.hasFailedCheck()).toBe(false);

    tracker.setVerification([{ name: 'test', kind: 'test', method: 'fake', status: 'pass' }]);
    expect(tracker.hasPassingEvidence()).toBe(true);
    expect(tracker.hasFailedCheck()).toBe(false);

    tracker.setVerification([{ name: 'test', kind: 'test', method: 'fake', status: 'blocked' }]);
    expect(tracker.hasPassingEvidence()).toBe(false);
    expect(tracker.hasBlockedCheck()).toBe(true);
    expect(tracker.hasFailedCheck()).toBe(false);
    expect(tracker.getFailedChecks()).toHaveLength(0);

    tracker.setVerification([{ name: 'test', kind: 'test', method: 'fake', status: 'fail' }]);
    expect(tracker.hasPassingEvidence()).toBe(false);
    expect(tracker.hasFailedCheck()).toBe(true);
    expect(tracker.getFailedChecks()).toHaveLength(1);
  });

  it('builds a bounded execution snapshot with current step and failed checks', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setObjective('Continue the task');
    tracker.setSteps([
      { id: 'a', title: 'done', status: 'completed' },
      { id: 'b', title: 'current', status: 'in-progress' },
    ]);
    tracker.setVerification([
      { name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'fail', summary: 'bad type' },
      { name: 'lint', kind: 'lint', method: 'fake', status: 'pass', summary: 'ok' },
    ]);
    tracker.recordHistory('Completed edit_file src/a.ts', 'changed', 'ok');
    const snapshot = JSON.parse(tracker.summarizeForContext(5, 2, 10));
    expect(snapshot.objective).toBe('Continue the task');
    expect(snapshot.currentStep.id).toBe('b');
    expect(snapshot.verified).toBe(false);
    expect(snapshot.failedChecks).toBe(1);
    expect(snapshot.blockedChecks).toBe(0);
    expect(snapshot.recentHistory).toHaveLength(1);
    expect(snapshot).not.toHaveProperty('checkpoints');
  });
});
