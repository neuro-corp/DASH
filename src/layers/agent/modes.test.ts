import { describe, expect, it } from 'bun:test';
import {
  AGENT_MODES,
  filterToolsForMode,
  getAgentMode,
  isToolAllowedInMode,
  modeInstructions,
  parseAgentMode,
  resolveAgentMode,
} from './modes';

const tools = [
  { function: { name: 'read_file' } },
  { function: { name: 'write_file' } },
  { function: { name: 'run_command' } },
  { function: { name: 'run_tests' } },
  { function: { name: 'web_search' } },
  { function: { name: 'update_task_plan' } },
];

describe('agent modes', () => {
  it('defaults to BUILD and resolves aliases', () => {
    expect(resolveAgentMode(undefined)).toBe('build');
    expect(resolveAgentMode('code')).toBe('build');
    expect(resolveAgentMode('planning')).toBe('plan');
    expect(resolveAgentMode('research')).toBe('explore');
    expect(resolveAgentMode('reviewer')).toBe('review');
    expect(resolveAgentMode('unknown-mode')).toBe('build');
    expect(parseAgentMode('/mode plan')).toBe('plan');
    expect(parseAgentMode('nonsense')).toBeUndefined();
  });

  it('keeps every tool in BUILD and restricts read-only modes', () => {
    expect(filterToolsForMode(tools, 'build').map(tool => tool.function.name))
      .toEqual(tools.map(tool => tool.function.name));

    const plan = filterToolsForMode(tools, 'plan').map(tool => tool.function.name);
    expect(plan).toContain('read_file');
    expect(plan).toContain('update_task_plan');
    expect(plan).toContain('web_search');
    expect(plan).not.toContain('write_file');
    expect(plan).not.toContain('run_command');
    expect(plan).not.toContain('run_tests');

    const explore = filterToolsForMode(tools, 'explore').map(tool => tool.function.name);
    expect(explore).toContain('read_file');
    expect(explore).not.toContain('write_file');
    expect(explore).not.toContain('update_task_plan');

    const review = filterToolsForMode(tools, 'review').map(tool => tool.function.name);
    expect(review).toContain('run_tests');
    expect(review).not.toContain('write_file');
  });

  it('keeps tool order stable and reports per-tool permissions', () => {
    expect(filterToolsForMode(tools, 'explore').map(tool => tool.function.name))
      .toEqual(['read_file', 'web_search']);
    expect(isToolAllowedInMode('build', 'write_file')).toBe(true);
    expect(isToolAllowedInMode('explore', 'write_file')).toBe(false);
    expect(isToolAllowedInMode('review', 'run_tests')).toBe(true);
  });

  it('gives each mode a short role instruction inside the shared prompt', () => {
    expect(modeInstructions('build')).toContain('make the requested code or project changes');
    expect(modeInstructions('build')).toContain('Read and search only enough');
    expect(modeInstructions('build')).toContain('instead of making the change');
    expect(modeInstructions('plan')).toContain('Do not modify project files');
    expect(modeInstructions('explore')).toContain('Do not modify files');
    expect(modeInstructions('review')).toContain('Do not modify project files');
    expect(getAgentMode('code')).toBe(AGENT_MODES.build);
  });
});
