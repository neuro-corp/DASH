import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTodo } from './tools';
import type { CheckResult } from './verify';

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'blocked';

export interface TaskStep {
  id: string;
  title: string;
  status: StepStatus;
  dependsOn?: string[];
  verification?: string[];
}

export interface HistoryEntry {
  index: number;
  ts: string;
  label: string;
  detail?: string;
  outcome: 'ok' | 'fail' | 'info';
}

const MAX_HISTORY = 100;
const MAX_CHANGED_FILES = 500;

export interface TaskStateData {
  objective: string;
  steps: TaskStep[];
  changedFiles: string[];
  history: HistoryEntry[];
  verification: CheckResult[];
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointEntry {
  relativePath: string;
  existed: boolean;
  content: string | null;
}

const STATE_DIR = path.join(os.homedir(), '.dash', 'workspace-state');

export function workspaceStateKey(workspaceRoot: string, sessionId?: string): string {
  const base = path.resolve(workspaceRoot)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const sessionKey = sessionId
    ?.replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return sessionKey ? `${base}__${sessionKey}` : base;
}

export function taskStatePath(workspaceRoot: string, sessionId?: string): string {
  return path.join(STATE_DIR, `${workspaceStateKey(workspaceRoot, sessionId)}.json`);
}

export class TaskTracker {
  private objective = '';
  private steps: TaskStep[] = [];
  private changedFiles: string[] = [];
  private history: HistoryEntry[] = [];
  private verification: CheckResult[] = [];
  private createdAt = new Date().toISOString();
  private historyIndex = 0;
  private checkpoints = new Map<string, CheckpointEntry>();
  private persistPath: string;
  private sessionId?: string;

  constructor(workspaceRoot: string, sessionId?: string) {
    this.sessionId = sessionId;
    this.persistPath = taskStatePath(workspaceRoot, sessionId);
    this.loadPersisted();
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  private loadPersisted(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const data = parsed as Partial<TaskStateData>;
        this.objective = typeof data.objective === 'string' ? data.objective : '';
        this.steps = Array.isArray(data.steps) ? data.steps : [];
        this.changedFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
        this.history = Array.isArray(data.history) ? data.history : [];
        if (this.history.length) this.historyIndex = this.history[this.history.length - 1]?.index ?? 0;
        this.verification = Array.isArray(data.verification) ? data.verification : [];
      }
    } catch { /* No persisted state or unreadable file; start fresh. */ }
  }

  private persist(): void {
    try {
      const directory = path.dirname(this.persistPath);
      fs.mkdirSync(directory, { recursive: true });
      const data: TaskStateData = {
        objective: this.objective,
        steps: this.steps,
        changedFiles: this.changedFiles,
        history: this.history.slice(-MAX_HISTORY),
        verification: this.verification,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* Persistence is best-effort; task state stays in memory. */ }
  }

  setObjective(objective: string): void {
    if (this.objective && this.objective !== objective) {
      this.objective = objective;
      this.steps = [];
      this.changedFiles = [];
      this.verification = [];
      this.createdAt = new Date().toISOString();
    } else {
      this.objective = objective || this.objective;
    }
    this.persist();
  }

  /**
   * Prepare persisted state for a new agent run.
   *
   * Verification evidence is always per-run: carrying a previous run's failed
   * checks forward makes the agent start in "repairing" mode for failures that
   * may no longer be relevant. A different objective also resets the plan and
   * changed-file list; the same objective resumes them.
   */
  beginRun(objective: string): { resumed: boolean } {
    const resumed = Boolean(this.objective) && this.objective === objective;
    this.objective = objective || this.objective;
    this.verification = [];
    if (!resumed) {
      this.steps = [];
      this.changedFiles = [];
      this.createdAt = new Date().toISOString();
    }
    this.persist();
    return { resumed };
  }

  resetSteps(): void {
    this.objective = '';
    this.steps = [];
    this.changedFiles = [];
    this.history = [];
    this.historyIndex = 0;
    this.verification = [];
    this.createdAt = new Date().toISOString();
    this.persist();
  }

  private normalizeSteps(raw: unknown): TaskStep[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const steps: TaskStep[] = [];
    const ids = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Record<string, unknown>;
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      if (!title) continue;
      let id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : `step-${steps.length + 1}`;
      while (ids.has(id)) id = `${id}-${steps.length + 1}`;
      ids.add(id);
      const dependsOn = Array.isArray(candidate.dependsOn) ? candidate.dependsOn.map(String) : undefined;
      const verification = Array.isArray(candidate.verification) ? candidate.verification.map(String) : undefined;
      const statusInput = typeof candidate.status === 'string' ? candidate.status : '';
      const status: StepStatus = statusInput === 'completed' || statusInput === 'in-progress' || statusInput === 'failed' || statusInput === 'blocked'
        ? statusInput as StepStatus
        : 'pending';
      steps.push({ id, title, status, dependsOn, verification });
    }
    return steps.slice(0, 50);
  }

  setSteps(raw: unknown): TaskStep[] {
    const steps = this.normalizeSteps(raw);
    if (steps) this.steps = steps;
    this.persist();
    return steps ?? [];
  }

  getSteps(): TaskStep[] {
    return [...this.steps];
  }

  getObjective(): string {
    return this.objective;
  }

  getStep(id: string): TaskStep | undefined {
    return this.steps.find(step => step.id === id);
  }

  setStep(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const candidate = raw as Record<string, unknown>;
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    if (!title) return;
    const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : `step-${Date.now()}`;
    const existing = this.getStep(id);
    if (existing) {
      existing.title = title;
      if (typeof candidate.status === 'string' && ['pending', 'in-progress', 'completed', 'failed', 'blocked'].includes(candidate.status)) {
        existing.status = candidate.status as StepStatus;
      }
      if (Array.isArray(candidate.dependsOn)) existing.dependsOn = candidate.dependsOn.map(String);
      if (Array.isArray(candidate.verification)) existing.verification = candidate.verification.map(String);
    } else {
      const dependsOn = Array.isArray(candidate.dependsOn) ? candidate.dependsOn.map(String) : undefined;
      const verification = Array.isArray(candidate.verification) ? candidate.verification.map(String) : undefined;
      const statusInput = typeof candidate.status === 'string' ? candidate.status : '';
      const status: StepStatus = statusInput === 'completed' || statusInput === 'in-progress' || statusInput === 'failed' || statusInput === 'blocked'
        ? statusInput as StepStatus
        : 'pending';
      this.steps.push({ id, title, status, dependsOn, verification });
      if (this.steps.length > 50) this.steps = this.steps.slice(-50);
    }
    this.persist();
  }

  removeStepAt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.steps.length) return;
    const [removed] = this.steps.splice(index, 1);
    this.recordHistory(`Removed step ${removed?.id ?? index + 1}`, removed?.title, 'info');
    this.persist();
  }

  private stepSatisfied(step: TaskStep): boolean {
    return (step.dependsOn ?? []).every(dep => this.steps.find(candidate => candidate.id === dep)?.status === 'completed');
  }

  nextStep(): TaskStep | undefined {
    const inProgress = this.steps.find(step => step.status === 'in-progress');
    if (inProgress) return inProgress;
    return this.steps.find(step => step.status === 'pending' && this.stepSatisfied(step));
  }

  hasPendingWork(): boolean {
    return this.steps.some(step => {
      if (step.status === 'in-progress') return true;
      return step.status === 'pending' || step.status === 'failed' || (step.status === 'blocked' && this.stepSatisfied(step));
    });
  }

  beginStep(id: string): TaskStep | undefined {
    const step = this.getStep(id);
    if (step) {
      step.status = 'in-progress';
      this.recordHistory(`Started step ${step.id}`, step.title, 'info');
      this.persist();
    }
    return step;
  }

  completeStep(id: string): TaskStep | undefined {
    const step = this.getStep(id);
    if (step) {
      step.status = 'completed';
      this.recordHistory(`Completed step ${step.id}`, step.title, 'ok');
      this.persist();
    }
    return step;
  }

  failStep(id: string, reason?: string): TaskStep | undefined {
    const step = this.getStep(id);
    if (step) {
      step.status = 'failed';
      this.recordHistory(`Failed step ${step.id}`, reason ?? step.title, 'fail');
      this.persist();
    }
    return step;
  }

  relinearizePlan(reason: string): void {
    for (const step of this.steps) {
      if (step.status === 'in-progress') step.status = 'pending';
    }
    this.recordHistory('Plan reassessed', reason, 'info');
    this.persist();
  }

  addChangedFile(relativeFile: string): void {
    const normalized = relativeFile.replace(/\\/g, '/');
    if (!normalized) return;
    if (!this.changedFiles.includes(normalized) && this.changedFiles.length < MAX_CHANGED_FILES) {
      this.changedFiles.push(normalized);
    }
    // Every write invalidates previous verification evidence, including an edit
    // to a file that was already listed. Otherwise the agent treats a stale
    // green result as covering code it has just changed again.
    this.verification = [];
    this.persist();
  }

  getChangedFiles(): string[] {
    return [...this.changedFiles];
  }

  recordHistory(label: string, detail?: string, outcome: 'ok' | 'fail' | 'info' = 'info'): void {
    this.historyIndex += 1;
    this.history = [...this.history.slice(-(MAX_HISTORY - 1)), {
      index: this.historyIndex,
      ts: new Date().toISOString(),
      label,
      detail: detail?.slice(0, 400),
      outcome,
    }];
    this.persist();
  }

  getHistory(limit = 20): HistoryEntry[] {
    return this.history.slice(-limit);
  }

  setVerification(results: CheckResult[]): void {
    this.verification = results;
    this.persist();
  }

  getVerification(): CheckResult[] {
    return [...this.verification];
  }

  allVerificationPassed(): boolean {
    return this.verification.some(result => result.status === 'pass')
      && this.verification.every(result => result.status === 'pass' || result.preExisting === true);
  }

  hasFailedCheck(): boolean {
    return this.verification.some(result => result.status === 'fail' && result.preExisting !== true);
  }

  hasBlockedCheck(): boolean {
    return this.verification.some(result => result.status === 'blocked');
  }

  hasPassingEvidence(): boolean {
    return this.allVerificationPassed();
  }

  getFailedChecks(): CheckResult[] {
    return this.verification.filter(result => result.status === 'fail' && result.preExisting !== true);
  }

  getBlockedChecks(): CheckResult[] {
    return this.verification.filter(result => result.status === 'blocked');
  }

  getUnresolvedChecks(): CheckResult[] {
    return this.verification.filter(result =>
      (result.status === 'fail' && result.preExisting !== true) || result.status === 'blocked');
  }

  getPendingStep(): TaskStep | undefined {
    return this.nextStep();
  }

  async prepareChange(absolutePath: string, workspaceRoot: string): Promise<void> {
    await this.recordCheckpoint(absolutePath, workspaceRoot);
    this.addChangedFile(path.relative(workspaceRoot, absolutePath));
  }

  async recordCheckpoint(absolutePath: string, workspaceRoot: string): Promise<void> {
    if (this.checkpoints.size >= 200) return;
    const relative = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
    if (this.checkpoints.has(relative)) return;
    let existed = false;
    let content: string | null = null;
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.isFile() && stat.size <= 512 * 1024) {
        existed = true;
        content = fs.readFileSync(absolutePath, 'utf8');
      } else if (stat.isFile()) {
        existed = true;
      }
    } catch { /* File did not exist yet. */ }
    this.checkpoints.set(relative, { relativePath: relative, existed, content });
    this.persist();
  }

  async rollbackCheckpoints(workspaceRoot: string): Promise<string[]> {
    const restored: string[] = [];
    for (const entry of [...this.checkpoints.values()].reverse()) {
      const absolute = path.join(workspaceRoot, entry.relativePath);
      try {
        if (entry.existed && entry.content !== null) fs.writeFileSync(absolute, entry.content, 'utf8');
        else if (!entry.existed) fs.rmSync(absolute, { force: true, recursive: true });
        restored.push(entry.relativePath);
      } catch { /* Skip files that cannot be restored. */ }
    }
    this.checkpoints.clear();
    this.persist();
    return restored;
  }

  checkpointCount(): number {
    return this.checkpoints.size;
  }

  toTodos(): AgentTodo[] {
    return this.steps.map((step, index) => ({
      id: index + 1,
      title: step.title,
      status: step.status === 'completed' ? 'completed'
        : step.status === 'in-progress' ? 'in-progress'
        : step.status === 'failed' || step.status === 'blocked' ? 'in-progress'
        : 'not-started',
    }));
  }

  summarizeForContext(maxChangedFiles = 12, maxHistory = 5, maxSteps = 15): string {
    const completed = this.steps.filter(step => step.status === 'completed').length;
    const active = this.nextStep();
    const failedChecks = this.getFailedChecks();
    const blockedChecks = this.getBlockedChecks();
    const unresolved = this.getUnresolvedChecks();
    return JSON.stringify({
      objective: this.objective,
      steps: this.steps.slice(0, maxSteps).map(step => ({ id: step.id, title: step.title, status: step.status })),
      stepsTruncated: this.steps.length > maxSteps,
      completedSteps: completed,
      pendingSteps: this.steps.filter(step => step.status !== 'completed').length,
      currentStep: active ? { id: active.id, title: active.title, status: active.status } : null,
      changedFiles: this.changedFiles.slice(-maxChangedFiles),
      changedFileCount: this.changedFiles.length,
      verification: [...unresolved, ...this.verification.filter(result => result.status !== 'fail' && result.status !== 'blocked')]
        .slice(0, 8)
        .map(result => ({
          name: result.name,
          status: result.status,
          summary: result.summary?.slice(0, 200),
        })),
      failedChecks: failedChecks.length,
      blockedChecks: blockedChecks.length,
      verified: this.hasPassingEvidence(),
      recentHistory: this.history.slice(-maxHistory).map(entry => ({
        label: entry.label,
        outcome: entry.outcome,
        ts: entry.ts,
      })),
      historyCount: this.history.length,
    });
  }

  summarize(): string {
    const completed = this.steps.filter(step => step.status === 'completed').length;
    const failed = this.verification.filter(result => result.status === 'fail' && result.preExisting !== true);
    return JSON.stringify({
      objective: this.objective,
      steps: this.steps.map(step => ({ id: step.id, title: step.title, status: step.status })),
      completedSteps: completed,
      pendingSteps: this.steps.length ? this.steps.length - completed : 0,
      changedFiles: this.changedFiles.slice(-50),
      verification: this.verification.map(result => ({
        name: result.name, status: result.status, command: result.command, exitCode: result.exitCode,
        summary: result.failure?.slice(0, 300), preExisting: result.preExisting === true,
      })),
      recentHistory: this.history.slice(-10).map(entry => ({ label: entry.label, outcome: entry.outcome })),
      failedChecks: failed.length,
    });
  }
}
