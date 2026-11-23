/**
 * Agent modes share one unified system prompt. A mode only contributes a short
 * role-specific instruction and a tool permission set; it never forks the
 * personality or coding behavior of the agent.
 */
export type AgentMode = 'build' | 'plan' | 'explore' | 'review';

export interface AgentModeDefinition {
  id: AgentMode;
  label: string;
  description: string;
  /** Mode guidance appended to the unified prompt. */
  instructions: string;
  /** Tools explicitly allowed. `undefined` means every tool is allowed. */
  allowedTools?: ReadonlySet<string>;
}

const READ_ONLY_TOOLS = [
  'read_file', 'read_many', 'list_files', 'search_files', 'find_files', 'glob', 'grep',
  'codebase_search', 'get_file_outline', 'find_symbol',
  'get_file_info', 'get_workspace_index', 'get_project_map', 'get_project_scripts',
  'inspect_project', 'code_search', 'lsp', 'read_session_activity', 'read_memory',
  'get_task_status', 'get_changed_files', 'get_execution_history', 'get_check_results',
  'get_agent_knowledge', 'verify_changes', 'ask_user', 'skill_loader', 'git_status', 'git_diff',
] as const;

const EXPLORE_TOOLS = new Set<string>([...READ_ONLY_TOOLS, 'web_search', 'web_fetch']);
const REVIEW_TOOLS = new Set<string>([
  ...EXPLORE_TOOLS,
  'run_checks', 'run_tests', 'get_diagnostics',
]);
const PLAN_TOOLS = new Set<string>([
  ...EXPLORE_TOOLS,
  'todo_write', 'update_task_plan',
]);

export const AGENT_MODES: Record<AgentMode, AgentModeDefinition> = {
  build: {
    id: 'build',
    label: 'BUILD',
    description: 'Implement, modify, test, and verify project work.',
    instructions:
      'Mode: BUILD. Your default is to build: make the requested code or project changes in the workspace, then verify them. ' +
      'Read and search only enough to identify the right edit; stop exploring when you have sufficient context. ' +
      'Do not respond to an implementation request with analysis, a plan, or instructions instead of making the change. ' +
      'Prefer targeted edits and real tool results over narration.',
  },
  plan: {
    id: 'plan',
    label: 'PLAN',
    description: 'Analyze the workspace and produce a plan without ordinary project-file changes.',
    instructions:
      'Mode: PLAN. Investigate the workspace and produce a concrete, ordered plan. ' +
      'Do not modify project files or run commands that change state. Use task-plan tools to record the plan.',
    allowedTools: PLAN_TOOLS,
  },
  explore: {
    id: 'explore',
    label: 'EXPLORE',
    description: 'Read-only investigation and codebase discovery.',
    instructions:
      'Mode: EXPLORE. Investigate the workspace and report what you find. Do not modify files or run mutating commands.',
    allowedTools: EXPLORE_TOOLS,
  },
  review: {
    id: 'review',
    label: 'REVIEW',
    description: 'Inspect code and report defects without changing files by default.',
    instructions:
      'Mode: REVIEW. Inspect code and verification output, then report defects, risks, and concrete fixes. ' +
      'Do not modify project files unless the user explicitly asks for changes.',
    allowedTools: REVIEW_TOOLS,
  },
};

const MODE_ALIASES: Record<string, AgentMode> = {
  build: 'build',
  code: 'build',
  implement: 'build',
  plan: 'plan',
  planning: 'plan',
  explore: 'explore',
  exploration: 'explore',
  research: 'explore',
  review: 'review',
  reviewer: 'review',
};

export function resolveAgentMode(value: unknown): AgentMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  return MODE_ALIASES[normalized] ?? 'build';
}

export function getAgentMode(mode: AgentMode | string | undefined): AgentModeDefinition {
  return AGENT_MODES[resolveAgentMode(mode)];
}

export function isToolAllowedInMode(mode: AgentMode | string | undefined, toolName: string): boolean {
  const definition = getAgentMode(mode);
  return definition.allowedTools === undefined || definition.allowedTools.has(toolName);
}

/** Keep tool order stable while removing tools denied by the mode. */
export function filterToolsForMode<T extends { function: { name: string } }>(
  tools: readonly T[],
  mode: AgentMode | string | undefined,
): T[] {
  const definition = getAgentMode(mode);
  if (!definition.allowedTools) return [...tools];
  return tools.filter(tool => definition.allowedTools!.has(tool.function.name));
}

export function modeInstructions(mode: AgentMode | string | undefined): string {
  return getAgentMode(mode).instructions;
}

export function parseAgentMode(value: string): AgentMode | undefined {
  const normalized = value.trim().toLowerCase().replace(/^\/mode\s+/, '');
  if (!normalized) return undefined;
  return MODE_ALIASES[normalized];
}
