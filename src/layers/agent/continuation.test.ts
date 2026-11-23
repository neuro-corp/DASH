import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTaskObjective } from './continuation';
import { TaskTracker, taskStatePath } from './taskstate';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-continuation-'));
});

afterEach(async () => {
  await fs.rm(taskStatePath(workspaceRoot), { force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('task continuation prompts', () => {
  it('resolves a continue prompt to the prior objective so the plan resumes', () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setObjective('Implement the dashboard feature');
    tracker.setSteps([{ id: 'step-1', title: 'Finish the UI', status: 'in-progress' }]);

    const objective = resolveTaskObjective('continue', tracker);
    const run = tracker.beginRun(objective);

    expect(objective).toBe('Implement the dashboard feature');
    expect(run.resumed).toBe(true);
    expect(tracker.getSteps()).toHaveLength(1);
  });

  it('keeps new requests as new objectives', () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setObjective('Previous task');

    expect(resolveTaskObjective('Add a new endpoint', tracker)).toBe('Add a new endpoint');
  });
});
