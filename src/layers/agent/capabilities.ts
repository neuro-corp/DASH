export type CapabilityCategory =
  | 'inspect'
  | 'search'
  | 'read'
  | 'mutate'
  | 'execute'
  | 'verify'
  | 'plan'
  | 'state'
  | 'external'
  | 'interact';

export type CapabilitySideEffect =
  | 'none'
  | 'workspace-write'
  | 'process'
  | 'network'
  | 'task-state'
  | 'preference-write'
  | 'user-interaction';

export interface ToolDefinitionLike {
  type: string;
  function: {
    name: string;
    description: string;
    parameters?: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
  };
}

export interface CapabilityArgument {
  name: string;
  required: boolean;
  type: string;
}

export interface CapabilityRecovery {
  code: string;
  meaning: string;
  recovery: string;
}

export interface CapabilityKnowledge {
  name: string;
  summary: string;
  category: CapabilityCategory;
  useWhen: string;
  avoidWhen: string;
  sideEffects: CapabilitySideEffect;
  approval: 'none' | 'outside-workspace' | 'always';
  arguments: CapabilityArgument[];
  result: string;
  limitations: string[];
  recovery: CapabilityRecovery[];
  related: string[];
  source: 'tool-schema';
}

export interface CapabilityRegistry {
  capabilities: CapabilityKnowledge[];
  byName: Map<string, CapabilityKnowledge>;
}

interface CapabilityOverride {
  category?: CapabilityCategory;
  useWhen?: string;
  avoidWhen?: string;
  sideEffects?: CapabilitySideEffect;
  approval?: CapabilityKnowledge['approval'];
  result?: string;
  limitations?: string[];
  recovery?: string[];
  related?: string[];
}

const CATEGORY_BY_NAME: Record<string, CapabilityCategory> = {
  read_file: 'read',
  read_many: 'read',
  write_file: 'mutate',
  edit_file: 'mutate',
  list_files: 'inspect',
  search_files: 'search',
  run_command: 'execute',
  find_files: 'search',
  get_file_info: 'inspect',
  ask_user: 'interact',
  todo_write: 'plan',
  read_session_activity: 'inspect',
  read_memory: 'inspect',
  write_memory: 'mutate',
  web_search: 'external',
  web_fetch: 'external',
  multi_edit: 'mutate',
  multi_file_edit: 'mutate',
  git_tool: 'execute',
  delete_file: 'mutate',
  run_background: 'execute',
  get_diagnostics: 'verify',
  code_search: 'search',
  codebase_search: 'search',
  get_file_outline: 'inspect',
  find_symbol: 'search',
  verify_changes: 'verify',
  undo_checkpoint: 'mutate',
  inspect_project: 'inspect',
  get_project_map: 'inspect',
  get_workspace_index: 'inspect',
  refresh_workspace_index: 'inspect',
  get_project_scripts: 'inspect',
  run_checks: 'verify',
  run_tests: 'verify',
  verify_runtime: 'verify',
  get_check_results: 'state',
  update_task_plan: 'plan',
  get_task_status: 'state',
  get_changed_files: 'state',
  get_execution_history: 'state',
  get_agent_knowledge: 'inspect',
  grep: 'search',
  glob: 'search',
  apply_patch: 'mutate',
  create_directory: 'mutate',
  skill_loader: 'inspect',
  lsp: 'inspect',
  git_status: 'inspect',
  git_diff: 'inspect',
};

const CATEGORY_ORDER: CapabilityCategory[] = [
  'inspect', 'search', 'read', 'mutate', 'execute', 'verify', 'plan', 'state', 'external', 'interact',
];

const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'multi_edit', 'multi_file_edit', 'delete_file', 'undo_checkpoint', 'write_memory',
  'apply_patch', 'create_directory',
]);

const ALWAYS_APPROVAL_TOOLS = new Set([
  'run_command', 'run_background', 'delete_file', 'get_diagnostics', 'run_checks', 'run_tests',
  'verify_runtime', 'write_memory',
]);

const PROCESS_TOOLS = new Set([
  'run_command', 'run_background', 'git_tool', 'get_diagnostics', 'run_checks', 'run_tests', 'verify_runtime',
]);

const NETWORK_TOOLS = new Set(['web_search', 'web_fetch']);
const STATE_TOOLS = new Set(['todo_write', 'update_task_plan']);
const READ_TOOLS = new Set(['read_file', 'read_many', 'get_file_info', 'read_session_activity', 'read_memory', 'get_check_results', 'get_task_status', 'get_changed_files', 'get_execution_history']);

const DEFAULT_RECOVERY_BY_CATEGORY: Record<CapabilityCategory, string[]> = {
  inspect: ['invalid_arguments', 'tool_failed'],
  search: ['invalid_arguments', 'tool_failed'],
  read: ['file_not_found', 'not_a_file', 'file_too_large', 'stale_file'],
  mutate: ['invalid_arguments', 'stale_file', 'approval_denied', 'write_failed', 'verification_failed'],
  execute: ['approval_denied', 'cancelled', 'tool_failed'],
  verify: ['approval_denied', 'cancelled', 'verification_failed'],
  plan: ['invalid_arguments', 'tool_failed'],
  state: ['invalid_arguments', 'tool_failed'],
  external: ['cancelled', 'tool_failed'],
  interact: ['cancelled', 'tool_failed'],
};

const ERROR_RECOVERY: Record<string, { meaning: string; recovery: string }> = {
  tool_not_available: {
    meaning: 'The model requested a tool that was not exposed for this task and it was not executed.',
    recovery: 'Use only tools listed for this task. Choose an available equivalent or explain the capability blocker; do not retry the same unavailable name.',
  },
  unknown_tool: {
    meaning: 'The requested tool name is not registered in the canonical tool registry.',
    recovery: 'Use a registered tool name from the current tool list, or explain that the requested capability is unavailable.',
  },
  invalid_arguments: {
    meaning: 'The tool arguments do not match the tool schema.',
    recovery: 'Call get_agent_knowledge with this tool name, then retry with corrected arguments.',
  },
  text_not_found: {
    meaning: 'old_text was not present in the current file contents.',
    recovery: 'Re-read the exact lines with read_file and rebuild old_text from current content.',
  },
  ambiguous_match: {
    meaning: 'old_text matched more than one location.',
    recovery: 'Include more surrounding context so the match is unique, or use multi_edit with distinct regions.',
  },
  overlapping_edits: {
    meaning: 'Two multi_edit ranges overlapped or conflicted.',
    recovery: 'Merge the overlapping changes into one edit or split them into separate ordered edits.',
  },
  file_not_found: {
    meaning: 'The requested path does not exist.',
    recovery: 'Verify the path with list_files, find_files, or get_project_map before retrying.',
  },
  not_a_file: {
    meaning: 'The path exists but is a directory or another non-file entry.',
    recovery: 'Choose a file path, or use the directory-oriented tool for this operation.',
  },
  file_too_large: {
    meaning: 'The file exceeds a bounded read or mutation limit.',
    recovery: 'Read a line range with offset/limit, or replace the file with write_file when that is truly intended.',
  },
  stale_file: {
    meaning: 'The file changed after it was read.',
    recovery: 'Re-read the current file and regenerate the operation; do not retry the old arguments.',
  },
  approval_denied: {
    meaning: 'The user rejected the operation.',
    recovery: 'Do not retry the same operation. Ask the user or choose a non-destructive alternative.',
  },
  workspace_boundary: {
    meaning: 'The operation would leave the workspace boundary.',
    recovery: 'Use a workspace-relative path or obtain explicit approval for the outside path.',
  },
  write_failed: {
    meaning: 'The filesystem rejected the write.',
    recovery: 'Check permissions, open handles, and the parent directory, then retry only after correcting the cause.',
  },
  verification_failed: {
    meaning: 'The write could not be verified against the intended content.',
    recovery: 'Re-read the file and inspect its current state before any further mutation.',
  },
  tool_failed: {
    meaning: 'The tool failed without a more specific classification.',
    recovery: 'Inspect the structured message and relevant metadata; change the approach rather than repeating the call.',
  },
  cancelled: {
    meaning: 'The user or task budget cancelled the operation.',
    recovery: 'Stop the current action and report partial progress; do not silently restart it.',
  },
};

const OVERRIDES: Record<string, CapabilityOverride> = {
  read_file: {
    useWhen: 'Exact source lines are needed, or metadata/index results must be confirmed.',
    avoidWhen: 'A path, symbol, or unchanged-content question can be answered from index metadata.',
    result: 'Bounded lines with a signature/version, hash, total line count, and nextOffset when more lines remain.',
    limitations: ['Default limit 200 lines; maximum 2000.', 'Text files only.', 'Unchanged ranges may return unchanged metadata instead of content.'],
    recovery: ['file_not_found', 'file_too_large', 'stale_file', 'not_a_file'],
    related: ['get_file_info', 'code_search', 'edit_file'],
  },
  read_many: {
    useWhen: 'Several known files or configuration files need inspection together; use read_file for a single file or a deeper range.',
    avoidWhen: 'The file list is unknown (use find_files/search_files first) or one file needs extensive paging.',
    result: 'Bounded per-file contents or line ranges with hashes, metadata, and continuation offsets.',
    limitations: ['Maximum 10 files per call.', 'Combined content is capped; clipped files report a continuation offset.', 'Each failed path is reported independently.'],
    recovery: ['file_not_found', 'file_too_large', 'stale_file', 'not_a_file'],
    related: ['read_file', 'find_files', 'search_files'],
  },
  write_file: {
    useWhen: 'Creating a file, or replacing a whole file whose current contents are known.',
    avoidWhen: 'A small targeted change can be made safely with edit_file or multi_edit.',
    result: 'Structured mutation result with success, changed, verified, size, and hash.',
    limitations: ['Replaces the entire file.', 'Outside-workspace writes require approval.'],
    recovery: ['stale_file', 'approval_denied', 'verification_failed', 'write_failed', 'workspace_boundary'],
    related: ['read_file', 'edit_file', 'multi_edit'],
  },
  edit_file: {
    useWhen: 'One unique, targeted replacement is needed in an existing file.',
    avoidWhen: 'Several non-overlapping regions change together (use multi_edit), or the whole file is being replaced.',
    result: 'Structured mutation result with the matched line, changed, verified, size, and hash.',
    limitations: ['old_text must match exactly once.', 'Line-ending differences are normalized, but whitespace must still match.'],
    recovery: ['text_not_found', 'ambiguous_match', 'stale_file', 'approval_denied', 'verification_failed'],
    related: ['read_file', 'multi_edit', 'write_file'],
  },
  multi_edit: {
    useWhen: 'Several independent, non-overlapping edits are needed in one file atomically.',
    avoidWhen: 'One edit is enough, or edits depend on text introduced by another edit in the same batch.',
    result: 'Structured atomic result with the number of applied edits and verification details.',
    limitations: ['All edits apply to the original content; no partial writes.', 'Overlapping ranges are rejected.'],
    recovery: ['overlapping_edits', 'text_not_found', 'ambiguous_match', 'stale_file', 'approval_denied', 'verification_failed'],
    related: ['read_file', 'edit_file'],
  },
  multi_file_edit: {
    useWhen: 'One coordinated change requires exact-text edits in multiple existing files.',
    avoidWhen: 'Edits are independent and can be handled in one assistant batch, or a full-file replacement is required.',
    result: 'All targets are validated before writes; returns changed paths, edit counts, hashes, and rollback status on failure.',
    limitations: ['Maximum 10 files and 100 edits per file.', 'Ranges must be unique and non-overlapping in each original file.', 'Writes are staged and rollback is best-effort if an I/O failure occurs.', 'Outside-workspace targets require approval.'],
    recovery: ['text_not_found', 'ambiguous_match', 'overlapping_edits', 'stale_file', 'approval_denied', 'verification_failed', 'write_failed'],
    related: ['read_many', 'multi_edit', 'edit_file'],
  },
  apply_patch: {
    useWhen: 'Applying a valid unified diff or a complete *** Begin Patch block with exact current-file context.',
    avoidWhen: 'A small exact replacement can be done more simply with edit_file, or the source context has not been read.',
    result: 'Validated file changes; a context mismatch fails without applying the affected patch batch.',
    limitations: ['Requires file headers and correctly prefixed hunk lines.', 'Context must match the current file exactly; do not retry stale or malformed patch text.'],
    recovery: ['invalid_arguments', 'text_not_found', 'ambiguous_match', 'stale_file', 'approval_denied'],
    related: ['read_file', 'edit_file', 'multi_edit'],
  },
  delete_file: {
    useWhen: 'The user explicitly wants a file or directory deleted, moved, or renamed.',
    avoidWhen: 'The change can be made non-destructively, or the user has not authorized deletion.',
    result: 'Structured operation result after approval.',
    limitations: ['Destructive; always requires approval.', 'Verify the target before retrying after any error.'],
    recovery: ['approval_denied', 'file_not_found', 'workspace_boundary', 'tool_failed'],
    related: ['list_files', 'get_file_info', 'undo_checkpoint'],
  },
  run_command: {
    useWhen: 'A short non-interactive command is needed that no structured tool covers.',
    avoidWhen: 'A structured tool exists for the operation, or the command is long-running/interactive.',
    result: 'Command output with exit status, timeout, and truncation metadata.',
    limitations: ['Requires approval.', 'Default timeout 120 seconds.', 'Use run_background for long-running processes.'],
    recovery: ['approval_denied', 'cancelled', 'tool_failed'],
    related: ['run_background', 'run_checks', 'git_tool'],
  },
  get_project_map: {
    useWhen: 'Starting code work or orienting in an unfamiliar workspace.',
    avoidWhen: 'The needed file and lines are already known from current context.',
    result: 'Project summary plus source-attributed layout, commands, modules, docs, and index freshness.',
    limitations: ['Module roles are inferred from indexed paths unless a source document states them.', 'Stale index metadata is labeled.'],
    recovery: ['tool_failed'],
    related: ['inspect_project', 'get_workspace_index', 'read_file'],
  },
  inspect_project: {
    useWhen: 'Choosing package-manager, framework, entry-point, or verification commands.',
    avoidWhen: 'Current project metadata is already present in runtime context.',
    result: 'Detected ecosystem, package manager, frameworks, scripts, entry points, and command sources.',
    limitations: ['Detection is evidence-based and may omit unsupported ecosystems.', 'Missing commands remain missing; do not invent them.'],
    recovery: ['tool_failed'],
    related: ['get_project_map', 'get_project_scripts', 'run_checks'],
  },
  get_workspace_index: {
    useWhen: 'Checking index freshness or getting a compact workspace summary without walking files.',
    avoidWhen: 'Current task context already includes fresh index metadata.',
    result: 'Index status, counts, languages, categories, top directories, key files, and recent changes.',
    limitations: ['Metadata only; it does not establish file contents or correctness.'],
    recovery: ['tool_failed'],
    related: ['refresh_workspace_index', 'get_project_map', 'list_files'],
  },
  refresh_workspace_index: {
    useWhen: 'The index is stale, or large external changes happened outside Dash.',
    avoidWhen: 'The index is fresh; refresh is unnecessary overhead.',
    result: 'Index status and added, removed, and modified files.',
    limitations: ['Incremental refresh, not a substitute for reading changed content.'],
    recovery: ['tool_failed'],
    related: ['get_workspace_index'],
  },
  search_files: {
    useWhen: 'Locating literal or regex text across indexed workspace files.',
    avoidWhen: 'The path is already known, or a symbol-aware search is more appropriate.',
    result: 'Bounded matches with path, line, text, scanned counts, and a continuation cursor.',
    limitations: ['Text search, not semantic understanding.', 'Paged; follow nextCursor when truncated.'],
    recovery: ['invalid_arguments', 'tool_failed'],
    related: ['code_search', 'find_files', 'read_file'],
  },
  code_search: {
    useWhen: 'Searching indexed source text for an exact symbol string.',
    avoidWhen: 'Semantic definition/reference resolution is needed (use lsp), or exact source lines must be inspected (use read_file).',
    result: 'Paginated literal text matches with path and line metadata.',
    limitations: ['Literal text search, not semantic symbol resolution; confirm relevant matches by reading source.'],
    recovery: ['invalid_arguments', 'tool_failed'],
    related: ['search_files', 'read_file'],
  },
  run_checks: {
    useWhen: 'After implementation, or when the current verification state is unknown.',
    avoidWhen: 'No changed files exist and a fresh passing check already covers the same state.',
    result: 'Structured pass, fail, skipped, or blocked results with commands and failure summaries.',
    limitations: ['Skipped or blocked checks are not passes.', 'Requires approval and can be bounded by timeout.'],
    recovery: ['approval_denied', 'cancelled', 'verification_failed'],
    related: ['run_tests', 'get_check_results', 'verify_runtime'],
  },
  run_tests: {
    useWhen: 'A focused or full test run is the right verification for the change.',
    avoidWhen: 'Tests cannot run in the current environment; report that instead of claiming success.',
    result: 'Structured test results with pass/fail/skipped/blocked status and failure details.',
    limitations: ['Runs the discovered test command only.', 'Requires approval.', 'A skipped check is not green.'],
    recovery: ['approval_denied', 'cancelled', 'verification_failed'],
    related: ['run_checks', 'get_check_results'],
  },
  verify_runtime: {
    useWhen: 'A startup/serve smoke check is needed after runtime-affecting changes.',
    avoidWhen: 'No serve/start command exists, or a static check is sufficient.',
    result: 'Startup readiness result; the process is stopped afterward.',
    limitations: ['Requires approval.', 'No serve command means skipped, not passed.'],
    recovery: ['approval_denied', 'cancelled', 'tool_failed'],
    related: ['run_checks', 'run_background'],
  },
  get_task_status: {
    useWhen: 'Resuming work, checking pending steps, or distinguishing verified work from completed work.',
    avoidWhen: 'The current runtime context already contains a fresh compact task snapshot.',
    result: 'Objective, steps, next step, changed files, verification evidence, failures, and recent operations.',
    limitations: ['Reflects recorded state only; it does not prove unrecorded work happened.'],
    recovery: ['tool_failed'],
    related: ['update_task_plan', 'get_changed_files', 'get_execution_history'],
  },
  update_task_plan: {
    useWhen: 'Multi-step work needs an explicit plan; replaces the whole plan with the provided step set.',
    avoidWhen: 'The request is conversational or a single trivial action.',
    result: 'Saved steps synchronized with the todo checklist; stale steps not included are removed.',
    limitations: ['Provide the full desired step set.', 'Status changes do not themselves run verification.'],
    recovery: ['invalid_arguments', 'tool_failed'],
    related: ['todo_write', 'get_task_status'],
  },
  get_execution_history: {
    useWhen: 'Reviewing recent mutations, commands, verification runs, and failures.',
    avoidWhen: 'The needed facts are already in the current context.',
    result: 'Bounded recent history entries with timestamps, outcomes, and short details.',
    limitations: ['History is capped and pruned; it is not a full audit log.'],
    recovery: ['invalid_arguments', 'tool_failed'],
    related: ['get_task_status', 'get_changed_files'],
  },
  get_agent_knowledge: {
    useWhen: 'Unsure which tool fits, or a structured tool error needs a recovery path.',
    avoidWhen: 'The tool name and recovery are already known from current context.',
    result: 'Bounded capability details and error-recovery guidance.',
    limitations: ['Guidance is derived from current tool schemas; it does not execute work.'],
    recovery: ['invalid_arguments'],
    related: ['get_project_map', 'get_task_status'],
  },
  read_session_activity: {
    useWhen: 'Recalling prior user requests or work from this or a saved session.',
    avoidWhen: 'The conversation already contains the relevant context.',
    result: 'Bounded recent session activity.',
    limitations: ['Only persisted session content is available.', 'Not a source of new project facts.'],
    recovery: ['invalid_arguments', 'tool_failed'],
    related: ['read_memory'],
  },
  read_memory: {
    useWhen: 'Persistent user preferences or facts may affect the request.',
    avoidWhen: 'The request is unrelated to stored preferences.',
    result: 'User-approved private memory content.',
    limitations: ['May be empty or stale; prefer current explicit user instructions.'],
    recovery: ['tool_failed'],
    related: ['write_memory'],
  },
  write_memory: {
    useWhen: 'The user approves storing a concise durable preference or fact.',
    avoidWhen: 'The information is task-specific, secret, or not approved.',
    result: 'Structured approval and write result.',
    limitations: ['Requires explicit user approval.', 'Writes a short replacement memory file.'],
    recovery: ['approval_denied', 'write_failed'],
    related: ['read_memory'],
  },
};

function firstSentence(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const match = /^(.{0,180}?[.!?])(?:\s|$)/.exec(compact);
  return (match?.[1] ?? compact.slice(0, 180)).trim();
}

function argumentType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const candidate = schema as Record<string, unknown>;
  if (typeof candidate.type === 'string') return candidate.type;
  if (Array.isArray(candidate.enum)) return 'enum';
  return 'unknown';
}

function capabilitiesForCategory(category: CapabilityCategory, registry: CapabilityRegistry): CapabilityKnowledge[] {
  return registry.capabilities.filter(capability => capability.category === category);
}

function buildRecovery(codes: string[]): CapabilityRecovery[] {
  return codes
    .map(code => {
      const guide = ERROR_RECOVERY[code];
      return guide ? { code, ...guide } : undefined;
    })
    .filter((entry): entry is CapabilityRecovery => Boolean(entry));
}

function derivedSideEffects(name: string): CapabilitySideEffect {
  if (name.startsWith('mcp_')) return 'network';
  if (name === 'write_memory') return 'preference-write';
  if (name === 'ask_user') return 'user-interaction';
  if (MUTATING_TOOLS.has(name)) return 'workspace-write';
  if (PROCESS_TOOLS.has(name)) return 'process';
  if (NETWORK_TOOLS.has(name)) return 'network';
  if (STATE_TOOLS.has(name)) return 'task-state';
  return 'none';
}

function derivedCategory(name: string): CapabilityCategory {
  if (name.startsWith('mcp_')) return 'external';
  if (CATEGORY_BY_NAME[name]) return CATEGORY_BY_NAME[name]!;
  if (MUTATING_TOOLS.has(name)) return 'mutate';
  if (PROCESS_TOOLS.has(name)) return 'execute';
  if (NETWORK_TOOLS.has(name)) return 'external';
  if (STATE_TOOLS.has(name)) return 'plan';
  if (READ_TOOLS.has(name)) return 'read';
  return 'inspect';
}

function derivedApproval(name: string, sideEffects: CapabilitySideEffect): CapabilityKnowledge['approval'] {
  if (name.startsWith('mcp_') || ALWAYS_APPROVAL_TOOLS.has(name) || name === 'undo_checkpoint') return 'always';
  if (sideEffects === 'workspace-write' || sideEffects === 'process') return 'outside-workspace';
  return 'none';
}

function defaultRelated(name: string, registryEntries: CapabilityKnowledge[]): string[] {
  return registryEntries
    .filter(capability => capability.name !== name)
    .filter(capability => capability.category === derivedCategory(name))
    .slice(0, 3)
    .map(capability => capability.name);
}

export function buildCapabilityRegistry(tools: readonly ToolDefinitionLike[]): CapabilityRegistry {
  const capabilities: CapabilityKnowledge[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = tool.function.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const override = OVERRIDES[name] ?? {};
    const category = override.category ?? derivedCategory(name);
    const sideEffects = override.sideEffects ?? derivedSideEffects(name);
    const properties = tool.function.parameters?.properties ?? {};
    const required = new Set(tool.function.parameters?.required ?? []);
    const argumentsList = Object.entries(properties).map(([argumentName, schema]) => ({
      name: argumentName,
      required: required.has(argumentName),
      type: argumentType(schema),
    }));
    capabilities.push({
      name,
      summary: firstSentence(tool.function.description || `${name} tool.`),
      category,
      useWhen: override.useWhen ?? firstSentence(tool.function.description || `Use ${name} when its operation fits the request.`),
      avoidWhen: override.avoidWhen ?? 'Avoid it when a more specific tool fits better or the needed information is already available.',
      sideEffects,
      approval: override.approval ?? derivedApproval(name, sideEffects),
      arguments: argumentsList,
      result: override.result ?? 'Structured tool output; inspect success and error metadata before relying on it.',
      limitations: override.limitations ?? ['Results reflect current tool behavior and must be verified when correctness matters.'],
      recovery: buildRecovery(override.recovery ?? DEFAULT_RECOVERY_BY_CATEGORY[category]),
      related: override.related ?? defaultRelated(name, capabilities),
      source: 'tool-schema',
    });
  }
  const byName = new Map(capabilities.map(capability => [capability.name, capability]));
  for (const capability of capabilities) {
    if (!capability.related.length) {
      capability.related = defaultRelated(capability.name, capabilities);
    }
  }
  return { capabilities, byName };
}

export function getCapability(registry: CapabilityRegistry, name: string): CapabilityKnowledge | undefined {
  return registry.byName.get(name.trim());
}

export function formatCapabilityOverview(registry: CapabilityRegistry): string {
  return CATEGORY_ORDER
    .map(category => {
      const names = capabilitiesForCategory(category, registry).map(capability => capability.name);
      return names.length ? `${category}: ${names.join(', ')}` : '';
    })
    .filter(Boolean)
    .join(' | ');
}

export function findCapabilities(registry: CapabilityRegistry, query: string, limit = 5): CapabilityKnowledge[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<{ capability: CapabilityKnowledge; score: number }> = [];
  for (const capability of registry.capabilities) {
    const name = capability.name.toLowerCase();
    const haystack = [
      capability.summary,
      capability.useWhen,
      capability.avoidWhen,
      capability.result,
      capability.limitations.join(' '),
      capability.related.join(' '),
      capability.recovery.map(entry => `${entry.code} ${entry.meaning} ${entry.recovery}`).join(' '),
    ].join(' ').toLowerCase();
    let score = 0;
    if (name === needle) score = 100;
    else if (name.includes(needle)) score = 80;
    else if (capability.category === needle) score = 70;
    else if (capability.recovery.some(entry => entry.code === needle)) score = 60;
    else if (haystack.includes(needle)) score = 40;
    if (score > 0) scored.push({ capability, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.capability.name.localeCompare(b.capability.name))
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map(entry => entry.capability);
}

export function recoveryForError(errorCode: string): CapabilityRecovery | undefined {
  const normalized = errorCode.trim().toLowerCase();
  const guide = ERROR_RECOVERY[normalized];
  return guide ? { code: normalized, ...guide } : undefined;
}

export function formatCapabilityKnowledge(query: string, capabilities: CapabilityKnowledge[]): string {
  const recovery = recoveryForError(query);
  const payload = {
    query,
    source: 'tool-schema',
    capabilities: capabilities.map(capability => ({
      name: capability.name,
      category: capability.category,
      summary: capability.summary,
      useWhen: capability.useWhen,
      avoidWhen: capability.avoidWhen,
      sideEffects: capability.sideEffects,
      approval: capability.approval,
      arguments: capability.arguments,
      result: capability.result,
      limitations: capability.limitations,
      recovery: capability.recovery,
      related: capability.related,
    })),
    ...(recovery ? { errorRecovery: recovery } : {}),
    ...(capabilities.length || recovery ? {} : {
      hint: 'Query a tool name, a capability category, or a structured error code such as stale_file.',
    }),
  };
  let serialized = JSON.stringify(payload);
  while (serialized.length > 11_800 && payload.capabilities.length > 1) {
    payload.capabilities.pop();
    serialized = JSON.stringify(payload);
  }
  return serialized;
}

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name) || name.startsWith('mcp_');
}

export function shouldRecordOperation(name: string, failed: boolean): boolean {
  return failed || MUTATING_TOOLS.has(name) || PROCESS_TOOLS.has(name) || name.startsWith('mcp_') || name === 'ask_user' || name === 'write_memory';
}

function readArgument(args: Record<string, unknown>): string {
  for (const key of ['path', 'pattern', 'query', 'command', 'symbol', 'action', 'session_id']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return '';
}

export function summarizeToolOperation(
  name: string,
  rawArgs: string,
  output: string,
  failed: boolean,
): { label: string; detail: string; outcome: 'ok' | 'fail' } {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawArgs || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { /* Malformed arguments are summarized without a target. */ }
  const target = readArgument(args);
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const payload = parsed as Record<string, unknown>;
      const message = typeof payload.message === 'string' ? payload.message : '';
      const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : '';
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      detail = [errorCode, message || summary].filter(Boolean).join(': ');
    }
  } catch { /* Plain-text output is summarized below. */ }
  if (!detail) detail = output.replace(/\s+/g, ' ').slice(0, 240);
  return {
    label: `${failed ? 'Failed' : 'Completed'} ${name}${target ? ` ${target}` : ''}`,
    detail: detail.slice(0, 400),
    outcome: failed ? 'fail' : 'ok',
  };
}

export function capabilityToolNames(registry: CapabilityRegistry): string[] {
  return registry.capabilities.map(capability => capability.name);
}
