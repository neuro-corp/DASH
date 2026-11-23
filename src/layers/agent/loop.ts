import type { NvidiaChatMessage, NvidiaToolCall } from '../../providers/nvidia';
import { ToolError, type ToolContext } from './tools';
import type { TaskTracker } from './taskstate';
import { buildProjectKnowledge, compactProjectKnowledge } from './project-knowledge';
import { shouldRecordOperation, summarizeToolOperation } from './capabilities';
import { getIndexSummary, type IndexSummary } from './workspace-index';
import { inspectProject } from './project';import { ReadLedger } from './read-ledger';
import { runChecks, annotateVerificationResults, hasVerifiableChanges, type CheckKind, type CheckResult } from './verify';
import { DEFAULT_AGENT_PROMPT_TOKENS } from '../../context-window';
import { resolveAgentStepLimit, isFinalAgentStep, MAX_AGENT_STEPS } from './config';

export function parseRawToolCall(content: string): { name: string; args: string } | null {
  // Strip possible markdown code fences ``` ```json ```
  let cleaned = content.replace(/```json\s*/i, '').replace(/```\s*$/i, '').trim();
  // Try to locate a JSON object
  const match = cleaned.match(/(\{[\s\S]*\})/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const name = record.name || record.tool;
  if (typeof name !== 'string') return null;
  const args = record.arguments !== undefined ? JSON.stringify(record.arguments) : '';
  return { name, args };
}

export type AgentPhase =
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'failed';

export interface ChatTurnResult {
  content: string;
  toolCalls: NvidiaToolCall[];
  usage?: TurnTokenUsage;
}

export interface ChatTurnOptions {
  /** Per-turn tool override. An empty array disables native tool calling. */
  tools?: readonly unknown[];
  /** Max tokens for this turn; if omitted the model default is used. */
  maxTokens?: number;
  /** Force streaming; defaults to true for NVIDIA NIM. */
  stream?: boolean;
}

export type ChatFunction = (
  messages: NvidiaChatMessage[],
  signal: AbortSignal | undefined,
  options?: ChatTurnOptions,
) => Promise<ChatTurnResult>;

export interface TurnTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type TokenUsageSource = 'provider' | 'estimated' | 'mixed';

export interface TokenPricing {
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
  outputPerMillion: number;
  currency?: string;
}

export interface TokenCost {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  total: number;
  currency: string;
}

export interface RequestTelemetry {
  request: number;
  turn: number;
  retry: number;
  startedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputSource: 'provider' | 'estimated';
  outputSource: 'provider' | 'estimated';
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  promptChars: number;
  toolSchemaTokens: number;
  toolCalls: number;
  toolOutputChars: number;
  cost?: TokenCost;
}

export interface AgentTelemetry {
  requestCount: number;
  requests: RequestTelemetry[];
  usageSource: TokenUsageSource;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  cost?: TokenCost;
  costSource?: 'provider-usage' | 'estimated-usage' | 'mixed';
}

export interface AgentMetrics {
  filesRead: number;
  bytesRead: number;
  indexHits: number;
  cacheHits: number;
  toolOutputTokens: number;
  estimatedPromptTokens: number;
  duplicateToolResultsSuppressed: number;
  obsoleteToolResultsOmitted: number;
  requestCount: number;
  actualPromptTokens: number;
  actualCompletionTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  toolSchemaTokens: number;
  workspaceIndex: {
    fileCount: number;
    generatedAt: string;
    stale: boolean;
  };
}

export type VerifyFunction = (options: {
  root: string;
  kinds?: CheckKind[];
  signal?: AbortSignal;
  files?: string[];
}) => Promise<CheckResult[]>;

/** Details of a context-window compaction, for display or diagnostics. */
export interface ContextCompactionInfo {
  /** Messages removed from the live conversation. */
  droppedMessages: number;
  /** Approximate tokens those messages occupied. */
  droppedTokens: number;
  /** Messages retained after compaction. */
  retainedMessages: number;
  /** Prompt budget (in tokens) that triggered the compaction. */
  maxPromptTokens: number;
}

export interface ToolExecutionTiming {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  status: 'success' | 'error';
}

export interface AgentLoopCallbacks {
  onStatus?: (phase: AgentPhase, message: string) => void;
  onThinking?: () => void;
  onText?: (chunk: string) => void;
  onTurnStart?: (turn: number) => void;
  onTurnEnd?: (turn: number) => void;
  onToolCall?: (toolCall: { id: string; name: string; args: string; startedAt: number }) => void;
  onToolResult?: (
    toolCall: { id: string; name: string; args: string },
    output: string,
    failed: boolean,
    timing?: ToolExecutionTiming,
  ) => void;
  onSystemNotice?: (message: string) => void;
  onRequestTelemetry?: (telemetry: RequestTelemetry) => void;
  onContextCompacted?: (info: ContextCompactionInfo) => void;
}

export interface AgentLoopOptions {
  workspaceRoot: string;
  objective: string;
  signal?: AbortSignal;
  chat: ChatFunction;
  tools: readonly unknown[];
  /** Tool names actually exposed to this task; rejects provider-invented calls. */
  allowedToolNames?: readonly string[];
  executeTool: (name: string, args: string, context: ToolContext) => Promise<string>;
  toolContext: ToolContext;
  tracker: TaskTracker;
  callbacks?: AgentLoopCallbacks;
  verify?: VerifyFunction;
  autoVerifyKinds?: CheckKind[];
  maxTurns?: number;
  maxToolCalls?: number;
  deadlineMs?: number;
  maxToolOutputChars?: number;
  maxHistoryMessages?: number;
  maxPromptTokens?: number;
  keepRecentToolResults?: number;
  omitOldToolResultChars?: number;
  pricing?: TokenPricing;
  systemMessage?: NvidiaChatMessage | string;
  initialMessages?: NvidiaChatMessage[];
  readLedger?: ReadLedger;
}

export interface AgentLoopResult {
  phase: AgentPhase;
  turns: number;
  toolsUsed: number;
  verification: CheckResult[];
  finalMessage: string;
  summary: string;
  interrupted: boolean;
  conversation: NvidiaChatMessage[];
  tokenUsage: TurnTokenUsage;
  telemetry: AgentTelemetry;
  metrics: AgentMetrics;
}

const DEFAULT_MAX_TURNS = MAX_AGENT_STEPS;
const DEFAULT_DEADLINE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 60;
const DEFAULT_MAX_PROMPT_TOKENS = DEFAULT_AGENT_PROMPT_TOKENS;
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 4;
const DEFAULT_OMIT_OLD_TOOL_RESULT_CHARS = 800;
const PROVIDER_ERROR_RETRIES = 2;
/** Same (normalized) tool call repeated this many times ends the run. */
const REPEAT_CALL_LIMIT = 3;
const STAGNANT_TURN_LIMIT = 6;
const STALL_NUDGE_LIMIT = 2;
const DEFAULT_MAX_TOOL_CALLS = 200;
const MAX_TOOL_CALL_LIMIT = 500;
const RETRY_BACKOFF_MS = [1500, 5000];

const BUDGET_NOTICE =
  'Execution budget reached. Tools are now disabled. Reply with a text-only final status report: what was completed, what remains incomplete, important errors or blockers, changed files, and what the user should do next. Do not request tools.';

const FINAL_STEP_NOTICE =
  'This is the final permitted step and tools are now disabled. Reply with a text-only final status report: what was completed, what remains incomplete, important errors or blockers, changed files, and what the user should do next. Do not request tools.';

const CONTINUE_NUDGE =
  'Your previous reply was empty or malformed. Do not treat this as a final answer. Continue the task now using tools where appropriate, or state precisely what is blocking you.';
const INTERIM_ACTION_NUDGE =
  'Your previous reply described an action you are about to take, but did not call a tool to perform it. Continue now by using the appropriate tool. If you cannot proceed, state the specific blocker instead of presenting the task as complete.';
const MAX_INTERIM_RESPONSE_NUDGES = 2;

const INTERIM_ACTION_RE = /\b(?:(?:okay|all right)[,.! ]+)?(?:(?:first|next|then)\s+)?(?:now\s+)?(?:let me|i(?:'ll| will| am going to| need to| should| can))\s+(?:create|write|edit|update|add|remove|delete|modify|change|inspect|read|open|search|run|test|build|implement|install|configure|fix|check)\b/i;

function isInterimActionNarration(content: string): boolean {
  return INTERIM_ACTION_RE.test(content.trim());
}

function isProviderProblem(content: string): boolean {
  if (/daily token limit reached/i.test(content)) return false;
  return /^(Error:|API error|Provider error|Empty model response)/i.test(content.trim());
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value.trim());
  return JSON.stringify(value) ?? 'null';
}

function callSignature(toolCall: NvidiaToolCall): string {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return `${toolCall.function.name}:${stableValue(parsed)}`;
  } catch {
    return `${toolCall.function.name}:${(toolCall.function.arguments || '').trim()}`;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Runtime facts the model needs but should not have to discover by probing
 * shell behavior. These are injected as reference metadata, never as work.
 */
function runtimeEnvironment(): { os: string; shell: string } {
  return {
    os: process.platform,
    shell: process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'sh'),
  };
}

function messageTokens(message: NvidiaChatMessage): number {
  const content = typeof message.content === 'string' ? message.content.length : 0;
  const calls = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  return estimateTokens('x'.repeat(content + calls));
}

function truncateToolOutput(output: string, limit: number): string {
  if (output.length <= limit) return output;
  const cut = output.slice(0, limit);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('\r'));
  const head = lastBreak > Math.floor(limit * 0.5) ? cut.slice(0, lastBreak) : cut;
  return `${head}\n…[truncated ${output.length - head.length} chars; request a specific line range to continue]…`;
}

function compactCommandOutput(output: string, limit: number): string {
  try {
    const payload = JSON.parse(output) as Record<string, unknown>;
    if (typeof payload.output !== 'string' || payload.output.length <= limit / 2) return truncateToolOutput(output, limit);
    const lines = payload.output.split(/\r?\n/);
    const interesting = lines
      .filter(line => /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|traceback|denied|not found|cannot find)\b/i.test(line))
      .slice(0, 120)
      .join('\n')
      .slice(0, Math.floor(limit * 0.35));
    const head = payload.output.slice(0, Math.floor(limit * 0.25));
    const tail = payload.output.slice(-Math.floor(limit * 0.2));
    const summary = [
      head,
      `…[${lines.length} output lines, ${payload.output.length} chars; head, matching errors, and tail retained]…`,
      interesting ? `Matching error lines:\n${interesting}` : '',
      tail,
    ].filter(Boolean).join('\n');
    const compacted = JSON.stringify({
      ...payload,
      output: summary,
      outputCompacted: true,
      outputLines: lines.length,
      outputChars: payload.output.length,
    });
    return compacted.length <= limit ? compacted : truncateToolOutput(compacted, limit);
  } catch {
    return truncateToolOutput(output, limit);
  }
}

function responseOutputText(response: ChatTurnResult): string {
  return `${response.content}${response.toolCalls.length > 0 ? JSON.stringify(response.toolCalls) : ''}`;
}

function compactToolOutput(toolName: string, output: string, limit: number): string {
  if (output.length <= limit) return output;
  if (toolName === 'run_command' || toolName === 'execute_command' || toolName === 'run_background') return compactCommandOutput(output, limit);
  return truncateToolOutput(output, limit);
}

function serializeToolFailure(error: unknown): string {
  if (error instanceof ToolError) {
    return JSON.stringify({
      success: false,
      failed: true,
      errorCode: error.code,
      message: error.message,
      retryable: error.retryable,
      hint: error.hint,
      details: error.details,
    });
  }
  return JSON.stringify({
    success: false,
    failed: true,
    errorCode: 'tool_failed',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    hint: 'Inspect the error and change the tool arguments or approach before retrying.',
  });
}

function parseStructuredToolOutput(output: string): Record<string, unknown> | undefined {
  if (!output.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function repeatedFailureOutput(toolName: string, args: string): string {
  return JSON.stringify({
    success: false,
    failed: true,
    errorCode: 'repeated_failure',
    message: `The identical ${toolName} call already failed and was not executed again.`,
    retryable: true,
    hint: 'Re-read the current file state or change the arguments before retrying; do not repeat the same call.',
    details: { tool: toolName, argsPreview: args.slice(0, 240) },
  });
}

function computeTokenCost(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteTokens: number,
  pricing: TokenPricing | undefined,
): TokenCost | undefined {
  if (!pricing) return undefined;
  const cached = Math.min(Math.max(cachedInputTokens, 0), inputTokens);
  const cacheWrite = Math.min(Math.max(cacheWriteTokens, 0), Math.max(0, inputTokens - cached));
  const uncached = Math.max(0, inputTokens - cached - cacheWrite);
  const cachedInput = cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) / 1_000_000;
  const cacheWriteCost = cacheWrite * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion) / 1_000_000;
  const input = uncached * pricing.inputPerMillion / 1_000_000;
  const output = outputTokens * pricing.outputPerMillion / 1_000_000;
  return {
    input,
    cachedInput,
    cacheWrite: cacheWriteCost,
    output,
    total: input + cachedInput + cacheWriteCost + output,
    currency: pricing.currency ?? 'USD',
  };
}

function addTokenCost(left: TokenCost | undefined, right: TokenCost | undefined): TokenCost | undefined {
  if (!right) return left;
  if (!left) return { ...right };
  return {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
    total: left.total + right.total,
    currency: left.currency,
  };
}

const STALE_CONTROL_PREFIXES = [
  'Task: ',
  'Runtime context',
  '<runtime_context>',
  'Workflow requirements:',
  'Provider error:',
  'Execution budget reached.',
  'Your task plan still has pending steps.',
  'You are repeating identical tool calls',
  'No changed files for several turns.',
  'Your previous reply described an action you are about to take',
  'Automated verification reported failing checks',
  'You reported completion, but changed files',
  'Your previous reply was empty or malformed.',
];

function isStaleControlMessage(message: NvidiaChatMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false;
  const content = message.content;
  return STALE_CONTROL_PREFIXES.some(prefix => content.startsWith(prefix));
}

function isRuntimeContextMessage(message: NvidiaChatMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false;
  return message.content.startsWith('<runtime_context>') || message.content.startsWith('Runtime context');
}

function sanitizeInitialMessages(messages: NvidiaChatMessage[]): NvidiaChatMessage[] {
  const hasPlainUser = messages.some(message => message.role === 'user'
    && typeof message.content === 'string'
    && !isStaleControlMessage(message));
  return messages.filter(message => {
    if (!isStaleControlMessage(message)) return true;
    if (typeof message.content === 'string' && message.content.startsWith('Workflow requirements:')) return false;
    return !hasPlainUser;
  });
}

const NON_RETRIEVABLE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'todo_write',
  'update_task_plan',
  'write_memory',
  'undo_checkpoint',
  'ask_user',
]);

/**
 * Read-only tools that may run concurrently when one model response requests
 * several independent inspections. Mutating, approval-gated, or interactive
 * tools always run sequentially.
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file', 'read_many', 'list_files', 'search_files', 'find_files', 'glob', 'grep',
  'get_file_info', 'get_workspace_index', 'get_project_map', 'get_project_scripts',
  'inspect_project', 'code_search', 'lsp', 'read_session_activity', 'read_memory',
  'get_task_status', 'get_changed_files', 'get_execution_history', 'get_check_results',
  'get_agent_knowledge', 'skill_loader', 'git_status', 'git_diff',
]);

function isRetrievableTool(toolName: string): boolean {
  return !NON_RETRIEVABLE_TOOLS.has(toolName);
}

function omittedToolResult(toolName: string, args: string, content: string): string {
  return JSON.stringify({
    omitted: true,
    tool: toolName,
    args: args.slice(0, 240),
    bytes: content.length,
    note: 'Older tool result omitted to save context. Re-run this tool if the information is still needed.',
  });
}

interface CompactOptions {
  maxMessages: number;
  maxToolOutputChars: number;
  maxTokens: number;
  pinnedIndices?: Set<number>;
  keepRecentToolResults?: number;
  omitOldToolResultChars?: number;
}

function compactMessages(
  messages: NvidiaChatMessage[],
  options: CompactOptions,
): { messages: NvidiaChatMessage[]; suppressed: number; omitted: number; droppedMessages: NvidiaChatMessage[] } {
  if (messages.length === 0) return { messages: [], suppressed: 0, omitted: 0, droppedMessages: [] };
  const totalTokens = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  const needsToolTruncation = messages.some(message => message.role === 'tool'
    && typeof message.content === 'string'
    && message.content.length > options.maxToolOutputChars);
  if (messages.length <= options.maxMessages && totalTokens <= options.maxTokens && !needsToolTruncation) {
    return { messages: messages.slice(), suppressed: 0, omitted: 0, droppedMessages: [] };
  }

  const keep = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === 'system' || options.pinnedIndices?.has(index)) keep.add(index);
  }
  let budget = options.maxTokens;
  for (const index of keep) budget -= messageTokens(messages[index] ?? { role: 'system' });
  const recentLimit = Math.max(1, Math.min(messages.length, options.maxMessages));
  let recentCount = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (keep.has(index)) continue;
    if (recentCount >= recentLimit) break;
    const message = messages[index];
    if (!message) continue;
    const cost = messageTokens(message);
    if (budget - cost < 0 && keep.size > 0) break;
    keep.add(index);
    budget -= cost;
    recentCount += 1;
  }

  const selected: NvidiaChatMessage[] = [...keep]
    .sort((a, b) => a - b)
    .map(index => messages[index])
    .filter((message): message is NvidiaChatMessage => Boolean(message))
    .map(message => {
      if (message.role !== 'tool' || typeof message.content !== 'string') return message;
      return { ...message, content: truncateToolOutput(message.content, options.maxToolOutputChars) };
    });

  const availableToolIds = new Set<string>();
  const sanitized: NvidiaChatMessage[] = [];
  const dangling: NvidiaChatMessage[] = [];
  for (const message of selected) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) availableToolIds.add(call.id);
      sanitized.push(message);
      continue;
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !availableToolIds.has(message.tool_call_id)) {
        dangling.push(message);
        continue;
      }
      sanitized.push(message);
      continue;
    }
    sanitized.push(message);
  }

  const argsById = new Map<string, string>();
  const nameById = new Map<string, string>();
  for (const message of sanitized) {
    for (const call of message.tool_calls ?? []) {
      argsById.set(call.id, call.function.arguments || '');
      nameById.set(call.id, call.function.name);
    }
  }
  const seen = new Set<string>();
  let suppressed = 0;
  const deduped = sanitized.map(message => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    const key = `${nameById.get(message.tool_call_id ?? '') ?? ''}\u0000${argsById.get(message.tool_call_id ?? '') ?? ''}\u0000${message.content}`;
    if (seen.has(key)) {
      suppressed += 1;
      return {
        ...message,
        content: JSON.stringify({
          deduplicated: true,
          note: 'Identical tool result already present earlier in retained context; reuse that result.',
        }),
      };
    }
    seen.add(key);
    return message;
  });

  const recentToolIds = new Set<string>();
  const keepRecentToolResults = Math.max(0, options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS);
  for (let index = deduped.length - 1; index >= 0 && recentToolIds.size < keepRecentToolResults; index--) {
    const message = deduped[index];
    if (message?.role === 'tool' && message.tool_call_id) recentToolIds.add(message.tool_call_id);
  }
  const omitThreshold = Math.max(0, options.omitOldToolResultChars ?? DEFAULT_OMIT_OLD_TOOL_RESULT_CHARS);
  let omitted = 0;
  const compacted = deduped.map(message => {
    if (message.role !== 'tool' || typeof message.content !== 'string' || !message.tool_call_id) return message;
    if (recentToolIds.has(message.tool_call_id) || message.content.length <= omitThreshold) return message;
    const toolName = nameById.get(message.tool_call_id) ?? '';
    if (!toolName || !isRetrievableTool(toolName)) return message;
    omitted += 1;
    return {
      ...message,
      content: omittedToolResult(toolName, argsById.get(message.tool_call_id) ?? '', message.content),
    };
  });
  const droppedMessages = [
    ...messages.filter((_, index) => !keep.has(index)),
    ...dangling,
  ];
  return { messages: compacted, suppressed, omitted, droppedMessages };
}

/** Marker used to recognise (and merge) summaries produced by compaction. */
export const CONTEXT_COMPACTION_MARKER = '[Context compacted';

export function isContextCompactionSummary(message: NvidiaChatMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(CONTEXT_COMPACTION_MARKER);
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Deterministic summary of the messages removed by compaction.
 *
 * Compaction must not require a second (paid) model call, so the summary is
 * built from the dropped content: the user requests that led here, the tools
 * that were used, and the previous summary when this is a repeat compaction.
 */
export function summarizeDroppedMessages(
  dropped: NvidiaChatMessage[],
  previousSummaries: string[] = [],
  taskState?: string,
): string {
  let droppedTokens = 0;
  const requests: string[] = [];
  const tools = new Map<string, number>();
  let assistantReplies = 0;
  let toolResults = 0;

  for (const message of dropped) {
    droppedTokens += messageTokens(message);
    if (message.role === 'tool') {
      toolResults += 1;
      continue;
    }
    if (message.role === 'assistant') {
      assistantReplies += 1;
      for (const call of message.tool_calls ?? []) {
        tools.set(call.function.name, (tools.get(call.function.name) ?? 0) + 1);
      }
      continue;
    }
    if (message.role === 'user' && typeof message.content === 'string') {
      const content = message.content.trim();
      if (!content || isStaleControlMessage(message) || isRuntimeContextMessage(message)) continue;
      if (content.startsWith(CONTEXT_COMPACTION_MARKER)) continue;
      requests.push(clipText(content.replace(/\s+/g, ' '), 160));
    }
  }

  const lines = [
    `${CONTEXT_COMPACTION_MARKER}: ${dropped.length} earlier message${dropped.length === 1 ? '' : 's'} (~${droppedTokens} tokens) were summarized to stay inside the model context window.]`,
  ];
  if (requests.length > 0) {
    lines.push(`Earlier user requests: ${requests.slice(-5).join(' | ')}`);
  }
  const toolLine = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
  if (toolLine) lines.push(`Earlier tools used: ${toolLine}`);
  lines.push(`Earlier assistant replies: ${assistantReplies}; earlier tool results: ${toolResults}.`);

  if (taskState && taskState.trim() && taskState.trim() !== '{}') {
    lines.push(`Active task state (preserved):\n${clipText(taskState, 900)}`);
  }

  const previous = previousSummaries.at(-1);
  if (previous) {
    lines.push(`Prior compaction summary:\n${clipText(previous, 900)}`);
  }
  lines.push('Continue from the retained conversation and current task state. Re-run a tool if exact older output is needed.');
  return clipText(lines.join('\n'), 2_400);
}

export function compactConversationForBudget(messages: NvidiaChatMessage[], options: CompactOptions): NvidiaChatMessage[] {
  return compactMessages(messages, options).messages;
}

export function compactConversationWithTelemetry(
  messages: NvidiaChatMessage[],
  options: CompactOptions,
): { messages: NvidiaChatMessage[]; suppressed: number; omitted: number; droppedMessages: NvidiaChatMessage[] } {
  return compactMessages(messages, options);
}

export function compactConversation(
  messages: NvidiaChatMessage[],
  maxMessages: number,
  maxToolOutputChars: number,
): NvidiaChatMessage[] {
  return compactConversationForBudget(messages, {
    maxMessages,
    maxToolOutputChars,
    maxTokens: Number.MAX_SAFE_INTEGER,
  });
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    workspaceRoot,
    objective,
    signal,
    chat,
    executeTool,
    toolContext,
    tracker,
    callbacks,
    verify = runChecks,
  } = options;
  const allowedToolNames = options.allowedToolNames === undefined
    ? undefined
    : new Set(options.allowedToolNames);
  const maxTurns = resolveAgentStepLimit(options.maxTurns ?? DEFAULT_MAX_TURNS);
  const requestedToolCallLimit = Number(options.maxToolCalls);
  const maxToolCalls = Number.isFinite(requestedToolCallLimit) && requestedToolCallLimit > 0
    ? Math.min(Math.trunc(requestedToolCallLimit), MAX_TOOL_CALL_LIMIT)
    : DEFAULT_MAX_TOOL_CALLS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxPromptTokens = options.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
  const keepRecentToolResults = options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  const omitOldToolResultChars = options.omitOldToolResultChars ?? DEFAULT_OMIT_OLD_TOOL_RESULT_CHARS;
  const toolSchemaTokens = estimateTokens(JSON.stringify(options.tools));
  const pricing = options.pricing
    && Number.isFinite(options.pricing.inputPerMillion)
    && Number.isFinite(options.pricing.outputPerMillion)
    ? options.pricing
    : undefined;
  const autoVerifyKinds = options.autoVerifyKinds ?? ['syntax', 'typecheck', 'test'];
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const readLedger = options.readLedger ?? toolContext.readLedger ?? new ReadLedger();
  if (!toolContext.readLedger) toolContext.readLedger = readLedger;
  const readResults = new Map<string, { signature: string; content: string }>();
  const pinnedIndices = new Set<number>();
  const metrics: AgentMetrics = {
    filesRead: 0,
    bytesRead: 0,
    indexHits: 0,
    cacheHits: 0,
    toolOutputTokens: 0,
    estimatedPromptTokens: 0,
    duplicateToolResultsSuppressed: 0,
    obsoleteToolResultsOmitted: 0,
    requestCount: 0,
    actualPromptTokens: 0,
    actualCompletionTokens: 0,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    toolSchemaTokens,
    workspaceIndex: { fileCount: 0, generatedAt: '', stale: true },
  };

  let phase: AgentPhase = 'planning';
  let turns = 0;
  let toolsUsed = 0;
  let lastFailedSignature = '';
  const signatureUses = new Map<string, number>();
  let lastToolCallSignature = '';
  let stagnantTurns = 0;
  let blankNudges = 0;
  let interimResponseNudges = 0;
  let lastChangeCount = tracker.getChangedFiles().length;
  let budgetFinalPending = false;
  let finalMessage = '';
  let interrupted = false;
  let tokenTotals: TurnTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const requestTelemetry: RequestTelemetry[] = [];
  let lastRequestTelemetry: RequestTelemetry | undefined;
  let estimatedInputTotal = 0;
  let estimatedOutputTotal = 0;
  let aggregateCost: TokenCost | undefined;
  let providerRequests = 0;
  let estimatedRequests = 0;

  const status = (nextPhase: AgentPhase, message: string): void => {
    phase = nextPhase;
    callbacks?.onStatus?.(nextPhase, message);
  };

  const conversation: NvidiaChatMessage[] = [];
  if (options.systemMessage) {
    pinnedIndices.add(conversation.length);
    conversation.push(typeof options.systemMessage === 'string'
      ? { role: 'system', content: options.systemMessage }
      : options.systemMessage);
  }
  for (const message of sanitizeInitialMessages(options.initialMessages ?? [])) {
    if (message.role === 'system') {
      if (conversation.length === 0) {
        pinnedIndices.add(conversation.length);
        conversation.push(message);
      }
      continue;
    }
    conversation.push(message);
  }
  let objectiveIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index--) {
    const message = conversation[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content === objective) {
      objectiveIndex = index;
      break;
    }
  }
  if (objectiveIndex === -1) {
    objectiveIndex = conversation.length;
    conversation.push({ role: 'user', content: objective });
  }
  pinnedIndices.add(objectiveIndex);
  const systemNotice = (message: string): void => {
    conversation.push({ role: 'user', content: message });
    callbacks?.onSystemNotice?.(message);
  };

  const runVerificationRound = async (): Promise<CheckResult[]> => {
    status('verifying', 'Running project verification checks');
    const files = tracker.getChangedFiles();
    // Verification is observational: results are recorded for the user and for
    // the task summary, but they never steer the loop. Unrelated pre-existing
    // failures must not send the agent off to investigate other people's bugs.
    const results = annotateVerificationResults(
      await verify({ root: workspaceRoot, kinds: autoVerifyKinds, signal, files }),
      files,
    );
    tracker.setVerification(results);
    callbacks?.onStatus?.('verifying', summarizeVerification(results));
    return results;
  };

  interface PreparedToolResult {
    lookup: { id: string; name: string; args: string };
    output: string;
    failed: boolean;
    startedAt: number;
  }

  const executeToolCall = async (
    toolCall: NvidiaToolCall,
    blockedOutput?: string,
    countAgainstBudget = true,
  ): Promise<PreparedToolResult> => {
    if (signal?.aborted) throw new Error('Task cancelled.');
    if (countAgainstBudget) toolsUsed += 1;
    const lookup = { id: toolCall.id, name: toolCall.function.name, args: toolCall.function.arguments };
    // Compatibility for models that use the common execute_command name.
    // Keep the canonical run_command allowlist and approval checks in force.
    const executionName = toolCall.function.name === 'execute_command' ? 'run_command' : toolCall.function.name;
    // Sanitise tool arguments – strip markdown fences and fix trailing commas
    let args = toolCall.function.arguments || '';
    args = args.replace(/```json\s*/i, '').replace(/```\s*$/i, '').trim();
    args = args.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
    toolCall.function.arguments = args;
    const startedAt = Date.now();
    callbacks?.onToolCall?.({ ...lookup, startedAt });
    let output = '';
    let failed = false;
    if (blockedOutput) {
      failed = true;
      output = blockedOutput;
    } else if (allowedToolNames && !allowedToolNames.has(executionName)) {
      failed = true;
      output = JSON.stringify({
        success: false,
        failed: true,
        errorCode: 'tool_not_available',
        message: `The ${toolCall.function.name} tool was not enabled for this task and was not executed.`,
        retryable: false,
        hint: 'Use only tools listed in the current request. If another capability is needed, explain the blocker.',
      });
    } else {
      try {
        output = await executeTool(executionName, toolCall.function.arguments, toolContext);
        const structuredOutput = parseStructuredToolOutput(output);
        // Plain-text tools violate the structured tool-result contract.
        if (!structuredOutput) {
          output = JSON.stringify({ success: false, message: output, retryable: true });
          failed = true;
        } else {
          failed = structuredOutput.success === false
            || structuredOutput.failed === true
            || output.startsWith('User denied');
        }
      } catch (error) {
        failed = true;
        output = serializeToolFailure(error);
      }
    }
    return { lookup, output, failed, startedAt };
  };

  const commitToolResult = (toolCall: NvidiaToolCall, prepared: PreparedToolResult): void => {
    const { lookup, output, failed } = prepared;
    const compactedOutput = compactToolOutput(toolCall.function.name, output, maxToolOutputChars);
    appendMessages([{
      role: 'tool',
      tool_call_id: toolCall.id,
      content: compactedOutput,
    }]);
    metrics.toolOutputTokens += estimateTokens(compactedOutput);
    if (lastRequestTelemetry) lastRequestTelemetry.toolOutputChars += compactedOutput.length;
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed && typeof parsed === 'object') {
        const payload = parsed as Record<string, unknown>;
        if (toolCall.function.name === 'read_many' && Array.isArray(payload.files)) {
          for (const entry of payload.files) {
            if (!entry || typeof entry !== 'object') continue;
            const file = entry as Record<string, unknown>;
            if (file.success !== true) continue;
            if (file.unchanged !== true) metrics.filesRead += 1;
            metrics.bytesRead += Number(file.bytesRead) || 0;
            if (file.fromCache === true) metrics.cacheHits += 1;
            if (file.indexHit === true) metrics.indexHits += 1;
          }
        } else {
          if (toolCall.function.name === 'read_file' && payload.unchanged !== true) metrics.filesRead += 1;
          metrics.bytesRead += Number(payload.bytesRead) || 0;
          if (payload.fromCache === true || payload.cached === true) metrics.cacheHits += 1;
          if (payload.indexHit === true) metrics.indexHits += 1;
        }
        if (typeof payload.signature === 'string') {
          readResults.set(toolCall.id, { signature: payload.signature, content: compactedOutput });
        }
      }
    } catch { /* Non-JSON tool output cannot carry read metadata. */ }
    if (toolContext.tracker && shouldRecordOperation(toolCall.function.name, failed)) {
      const operation = summarizeToolOperation(toolCall.function.name, toolCall.function.arguments, output, failed);
      toolContext.tracker.recordHistory(operation.label, operation.detail, operation.outcome);
    }
    const completedAt = Date.now();
    callbacks?.onToolResult?.(lookup, output, failed, {
      startedAt: prepared.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - prepared.startedAt),
      status: failed ? 'error' : 'success',
    });
  };

  const flushToolCall = async (
    toolCall: NvidiaToolCall,
    blockedOutput?: string,
    countAgainstBudget = true,
  ): Promise<boolean> => {
    const prepared = await executeToolCall(toolCall, blockedOutput, countAgainstBudget);
    commitToolResult(toolCall, prepared);
    return prepared.failed;
  };

  const appendMessages = (newMessages: NvidiaChatMessage[]): void => {
    conversation.push(...newMessages);
  };

  const compactedForPrompt = (): { messages: NvidiaChatMessage[]; suppressed: number; omitted: number; droppedMessages: NvidiaChatMessage[] } => compactMessages(conversation, {
    maxMessages: maxHistoryMessages,
    maxToolOutputChars,
    maxTokens: Math.max(1_000, maxPromptTokens - toolSchemaTokens),
    pinnedIndices,
    keepRecentToolResults,
    omitOldToolResultChars,
  });

  /**
   * When the live conversation exceeds the prompt budget, replace everything
   * that would be dropped with one deterministic summary message. This frees
   * the window for new work while preserving the requests and tool history.
   */
  const compactContextIfNeeded = (): void => {
    const promptTokens = conversation.reduce((sum, message) => sum + messageTokens(message), 0) + toolSchemaTokens;
    if (promptTokens <= maxPromptTokens) return;
    const compacted = compactedForPrompt();
    if (compacted.droppedMessages.length === 0) return;

    const previousSummaries = conversation
      .filter(isContextCompactionSummary)
      .map(message => String(message.content));
    const summaryMessage: NvidiaChatMessage = {
      role: 'user',
      content: summarizeDroppedMessages(
        compacted.droppedMessages,
        previousSummaries,
        (() => {
          try { return tracker.summarizeForContext(12, 5, 15); } catch { return ''; }
        })(),
      ),
    };
    const systemMessages = compacted.messages.filter(message => message.role === 'system');
    const retained = compacted.messages.filter(message =>
      message.role !== 'system' && !isContextCompactionSummary(message));

    conversation.length = 0;
    conversation.push(...systemMessages, summaryMessage, ...retained);

    // Indices changed, so rebuild the pinned set: system prompts, the summary
    // itself, and the original objective.
    pinnedIndices.clear();
    for (let index = 0; index < conversation.length; index++) {
      if (conversation[index]?.role === 'system') pinnedIndices.add(index);
    }
    pinnedIndices.add(systemMessages.length);
    for (let index = conversation.length - 1; index >= 0; index--) {
      const message = conversation[index];
      if (message?.role === 'user' && typeof message.content === 'string' && message.content === objective) {
        pinnedIndices.add(index);
        break;
      }
    }

    callbacks?.onContextCompacted?.({
      droppedMessages: compacted.droppedMessages.length,
      droppedTokens: compacted.droppedMessages.reduce((sum, message) => sum + messageTokens(message), 0),
      retainedMessages: retained.length,
      maxPromptTokens,
    });
  };

  const updateResidentReads = (messages: NvidiaChatMessage[]): void => {
    const resident = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'tool' || !message.tool_call_id) continue;
      const info = readResults.get(message.tool_call_id);
      if (info && message.content === info.content) resident.add(info.signature);
    }
    readLedger.setResidentSignatures(resident);
  };

  const chatTurn = async (turnOptions?: ChatTurnOptions): Promise<ChatTurnResult | undefined> => {
    compactContextIfNeeded();
    const activeTools = turnOptions?.tools ?? options.tools;
    const activeToolSchemaTokens = turnOptions?.tools === undefined
      ? toolSchemaTokens
      : estimateTokens(JSON.stringify(turnOptions.tools));
    for (let retry = 0; ; retry++) {
      if (signal?.aborted) return undefined;
      const compacted = compactedForPrompt();
      updateResidentReads(compacted.messages);
      const promptText = JSON.stringify(compacted.messages);
      const estimatedInputTokens = estimateTokens(promptText) + activeToolSchemaTokens;
      metrics.estimatedPromptTokens = estimatedInputTokens;
      metrics.duplicateToolResultsSuppressed = compacted.suppressed;
      metrics.obsoleteToolResultsOmitted = compacted.omitted;
      const requestStartedAt = Date.now();
      const response = await chat(compacted.messages, signal, { tools: activeTools });
      const usage = response.usage;
      const hasProviderUsage = Boolean(usage && usage.totalTokens > 0);
      const estimatedOutputTokens = estimateTokens(responseOutputText(response));
      const inputTokens = hasProviderUsage ? usage!.promptTokens : estimatedInputTokens;
      const outputTokens = hasProviderUsage ? usage!.completionTokens : estimatedOutputTokens;
      const totalTokens = hasProviderUsage ? usage!.totalTokens : inputTokens + outputTokens;
      const cachedInputTokens = usage?.cachedPromptTokens ?? 0;
      const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
      const reasoningTokens = usage?.reasoningTokens ?? 0;
      const extraOutputTokens = usage && usage.totalTokens > usage.promptTokens + usage.completionTokens
        ? Math.max(0, usage.totalTokens - usage.promptTokens - usage.completionTokens)
        : 0;
      const billableOutputTokens = outputTokens + extraOutputTokens;
      const cost = computeTokenCost(
        inputTokens,
        billableOutputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        pricing,
      );
      const requestNumber = requestTelemetry.length + 1;
      const telemetry: RequestTelemetry = {
        request: requestNumber,
        turn: turns + 1,
        retry,
        startedAt: new Date(requestStartedAt).toISOString(),
        durationMs: Date.now() - requestStartedAt,
        inputTokens,
        outputTokens,
        totalTokens,
        inputSource: hasProviderUsage ? 'provider' : 'estimated',
        outputSource: hasProviderUsage ? 'provider' : 'estimated',
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        reasoningTokens,
        promptChars: promptText.length,
        toolSchemaTokens: activeToolSchemaTokens,
        toolCalls: response.toolCalls.length,
        toolOutputChars: 0,
        ...(cost ? { cost } : {}),
      };
      requestTelemetry.push(telemetry);
      lastRequestTelemetry = telemetry;
      metrics.requestCount = requestTelemetry.length;
      estimatedInputTotal += estimatedInputTokens;
      estimatedOutputTotal += estimatedOutputTokens;
      aggregateCost = addTokenCost(aggregateCost, cost);
      if (hasProviderUsage) {
        providerRequests += 1;
        metrics.actualPromptTokens += usage!.promptTokens;
        metrics.actualCompletionTokens += usage!.completionTokens;
        metrics.cachedPromptTokens += cachedInputTokens;
        metrics.cacheWriteTokens += cacheWriteTokens;
        metrics.reasoningTokens += reasoningTokens;
        tokenTotals = {
          promptTokens: tokenTotals.promptTokens + usage!.promptTokens,
          completionTokens: tokenTotals.completionTokens + usage!.completionTokens,
          totalTokens: tokenTotals.totalTokens + usage!.totalTokens,
        };
      } else {
        estimatedRequests += 1;
      }
      callbacks?.onRequestTelemetry?.(telemetry);
      if (response.toolCalls.length > 0) return response;
      // Let the outer loop handle empty output with a continuation nudge. A
      // blind provider retry repeats the same prompt and can turn an empty
      // response into a false `No response` completion.
      if (!response.content.trim()) return response;
      // ── Fallback: raw JSON tool call embedded in content ───────────────────────
      if (response.toolCalls.length === 0 && typeof response.content === 'string' && response.content.length > 0) {
        const parsed = parseRawToolCall(response.content);
        if (parsed && (!allowedToolNames || allowedToolNames.has(parsed.name))) {
          const synthetic: NvidiaToolCall = {
            id: 'fallback-' + Date.now(),
            type: 'function' as const,
            function: {
              name: parsed.name,
              arguments: parsed.args,
            },
          };
          // discard the raw content so it isn’t sent back as chat text
          return { content: '', toolCalls: [synthetic] };
        }
      }
      if (response.content && !isProviderProblem(response.content)) return response;
      if (retry >= PROVIDER_ERROR_RETRIES) {
        emergencyMessage(
          `The provider failed repeatedly: ${response.content || 'empty response'}. This is a transient provider problem, not a task failure. Continue at the last known good state, or report the blocker.`,
        );
        return { content: response.content, toolCalls: [] };
      }
      emergencyMessage(`Provider error: ${response.content || 'empty response'}. Typically transient — retry your previous action and continue.`);
      await new Promise<void>(resolve => {
        const ms = RETRY_BACKOFF_MS[Math.min(retry, RETRY_BACKOFF_MS.length - 1)] ?? 1500;
        setTimeout(resolve, ms);
      });
    }
  };

  const emergencyMessage = (message: string): void => {
    systemNotice(message);
  };

  tracker.beginRun(objective);
  lastChangeCount = tracker.getChangedFiles().length;
  let ecosystem: string | undefined;
  try { ecosystem = inspectProject(workspaceRoot).ecosystem; } catch { ecosystem = undefined; }
  let projectContext: Record<string, unknown> = { available: false };
  try {
    const knowledge = buildProjectKnowledge(workspaceRoot);
    projectContext = compactProjectKnowledge(knowledge);
    metrics.workspaceIndex = {
      fileCount: knowledge.freshness.fileCount,
      generatedAt: knowledge.freshness.indexGeneratedAt,
      stale: knowledge.freshness.indexStale,
    };
  } catch {
    let indexSummary: IndexSummary | undefined;
    try { indexSummary = getIndexSummary(workspaceRoot); } catch { /* Index failures fall back to direct inspection. */ }
    if (indexSummary) {
      metrics.workspaceIndex = {
        fileCount: indexSummary.fileCount,
        generatedAt: indexSummary.generatedAt,
        stale: indexSummary.stale,
      };
      projectContext = {
        available: true,
        fileCount: indexSummary.fileCount,
        directoryCount: indexSummary.directoryCount,
        topDirs: indexSummary.topDirs.slice(0, 12),
        languages: indexSummary.languages,
        generatedAt: indexSummary.generatedAt,
        stale: indexSummary.stale,
      };
    }
  }
  const ledgerContext = readLedger.snapshot(20).map(entry => ({
    path: entry.path,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    lineCount: entry.lineCount,
    ranges: entry.ranges,
  }));

  pinnedIndices.add(conversation.length);
  const taskState = (() => {
    try { return tracker.summarizeForContext(); } catch { return '{}'; }
  })();
  appendMessages([
    {
      role: 'user',
      content:
        '<runtime_context>\n' +
        'Reference information only, not a task. The user request is above.\n' +
        'Do not treat metadata or any failure in this block as work to do. Pre-existing failures are not listed.\n' +
        `Environment: ${JSON.stringify(runtimeEnvironment())}\n` +
        `Project knowledge: ${JSON.stringify(projectContext)}\n` +
        `Read ledger: ${JSON.stringify(ledgerContext)}\n` +
        `Task-state snapshot: ${taskState}\n` +
        '</runtime_context>',
    },
  ]);
  if (!options.systemMessage) {
    pinnedIndices.add(conversation.length);
    appendMessages([
      {
        role: 'user',
        content:
          'Workflow requirements:\n' +
          '0. If this request needs no code work (a plain question, explanation, greeting, or short conversation), answer conversationally with no tools and no plan.\n' +
          '0a. For a how/where question about changing code, provide guidance rather than editing unless the user explicitly asks for implementation. Find the answer with one targeted search for a distinctive symbol, label, or phrase, then read only the best matching file range and cite its path/location. Do not scan entry points, enumerate directories, inspect sibling files, or repeat reads for this case.\n' +
          '1. For broad or unfamiliar implementation work, start with project knowledge and the workspace metadata index (get_project_map, get_workspace_index, inspect_project) before reading files. For focused work, search the specific concept or symbol first and inspect only likely matches. Do not re-walk the project or re-read unchanged content; refresh only when metadata is stale.\n' +
          '2. Read only needed ranges with read_file offset/limit (default 200 lines). Follow nextOffset or nextCursor for large files and paged results.\n' +
          '3. For multi-step work, plan with todo_write/update_task_plan and keep the plan current. Use get_task_status when resuming or distinguishing verified from completed work.\n' +
          '4. Make focused edits after inspecting sufficient current source. Never invent tool results. Use get_agent_knowledge when tool choice or recovery is unclear.\n' +
          '4a. For large multi-part tasks, execute independent reads, edits, or checks together in a single tool-call batch when safe. Keep a concise plan, update its statuses as deliverables finish, and avoid repeated narration or re-inspection without new evidence.\n' +
          '5. After implementing code changes, run the project checks that cover the changed files (run_checks or run_tests) once before your final summary. Skip project-wide typecheck/tests/builds for isolated static assets (HTML, CSS, docs) unless the user asks. Do not re-run checks that already passed for unchanged files. Never weaken validation to pass, never count skipped or blocked checks as passing, and never report unrelated pre-existing failures as your own.\n' +
          '6. When the request is complete, stop: send one short final message. Do not repeat the summary, re-verify unchanged work, or continue planning for work the user did not ask for.',
      },
    ]);
  }
  const exposedToolNames = new Set(options.tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object') return [];
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    return typeof name === 'string' ? [name] : [];
  }));
  if (exposedToolNames.has('read_many') || exposedToolNames.has('multi_file_edit')) {
    appendMessages([{
      role: 'user',
      content:
        'Batch tool guidance: Use read_many when inspecting two or more known files/configs, with focused line ranges when possible. For coordinated edits across files, read the targets first and use multi_file_edit with each read hash as expected_hash; combine exact, non-overlapping edits per file. Use multi_edit for several edits in one file, edit_file for one targeted replacement, and write_file for new or intentionally replaced files. Do not use shell commands for ordinary workspace file reads or edits.',
    }]);
  }

  status('planning', 'Analyzing task and project');
  const buildTelemetry = (): AgentTelemetry => {
    const usageSource: TokenUsageSource = providerRequests === 0
      ? 'estimated'
      : estimatedRequests === 0
        ? 'provider'
        : 'mixed';
    const requests = requestTelemetry.map(request => ({
      ...request,
      ...(request.cost ? { cost: { ...request.cost } } : {}),
    }));
    return {
      requestCount: requests.length,
      requests,
      usageSource,
      inputTokens: requests.reduce((sum, request) => sum + request.inputTokens, 0),
      outputTokens: requests.reduce((sum, request) => sum + request.outputTokens, 0),
      totalTokens: requests.reduce((sum, request) => sum + request.totalTokens, 0),
      cachedInputTokens: requests.reduce((sum, request) => sum + request.cachedInputTokens, 0),
      cacheWriteTokens: requests.reduce((sum, request) => sum + request.cacheWriteTokens, 0),
      reasoningTokens: requests.reduce((sum, request) => sum + request.reasoningTokens, 0),
      estimatedInputTokens: estimatedInputTotal,
      estimatedOutputTokens: estimatedOutputTotal,
      estimatedTotalTokens: estimatedInputTotal + estimatedOutputTotal,
      ...(aggregateCost ? { cost: { ...aggregateCost } } : {}),
      ...(aggregateCost ? {
        costSource: providerRequests === 0
          ? 'estimated-usage' as const
          : estimatedRequests === 0
            ? 'provider-usage' as const
            : 'mixed' as const,
      } : {}),
    };
  };
  const resultState = (): AgentLoopResult => ({
    phase,
    turns,
    toolsUsed,
    verification: tracker.getVerification(),
    finalMessage,
    summary: tracker.summarize(),
    interrupted,
    conversation,
    tokenUsage: tokenTotals,
    telemetry: buildTelemetry(),
    metrics,
  });

  const finalStepReport = (): string => {
    const steps = tracker.getSteps();
    const completed = steps.filter(step => step.status === 'completed').map(step => step.title);
    const incomplete = steps.filter(step => step.status !== 'completed')
      .map(step => `${step.title} (${step.status})`);
    const changed = tracker.getChangedFiles();
    const failures = tracker.getVerification()
      .filter(result => result.status === 'fail' && result.preExisting !== true)
      .map(result => result.name);
    const lines = ['## Final status (step limit reached)'];
    lines.push(completed.length > 0
      ? `Completed: ${completed.slice(0, 8).join('; ')}`
      : 'Completed: no task step was recorded as completed.');
    lines.push(incomplete.length > 0
      ? `Incomplete: ${incomplete.slice(0, 8).join('; ')}`
      : 'Incomplete: no recorded task steps remain.');
    lines.push(changed.length > 0
      ? `Changed files: ${changed.slice(0, 12).join(', ')}`
      : 'Changed files: none recorded.');
    if (failures.length > 0) lines.push(`Important errors: failing checks for ${failures.slice(0, 8).join(', ')}.`);
    lines.push('Remaining work: review the incomplete items above and continue in a follow-up request.');
    return lines.join('\n');
  };

  try {
    while (true) {
      if (signal?.aborted) break;

      // The last permitted model iteration is reserved for the final report.
      if (Date.now() >= deadline || isFinalAgentStep(turns, maxTurns)) {
        if (!budgetFinalPending) {
          budgetFinalPending = true;
          const outOfTime = Date.now() >= deadline;
          status('blocked', outOfTime
            ? 'Execution budget reached; requesting final report'
            : 'Final step reached; requesting final report');
          emergencyMessage(outOfTime ? BUDGET_NOTICE : FINAL_STEP_NOTICE);
          callbacks?.onTurnStart?.(turns + 1);
          // Final permitted iteration: no tools are exposed and no tool call
          // may be executed, even if a provider returns one anyway.
          const response = await chatTurn({ tools: [] });
          if (!response) {
            interrupted = true;
            status('blocked', 'Execution budget reached before completion');
            break;
          }
          turns += 1;
          callbacks?.onTurnEnd?.(turns);
          const finalContent = response.content.trim() || finalStepReport();
          appendMessages([{ role: 'assistant', content: finalContent }]);
          finalMessage = finalContent;
          interrupted = true;
          status('blocked', 'Execution budget reached before completion');
          break;
        }
        interrupted = true;
        status('blocked', 'Execution budget reached');
        break;
      }

      status('executing', `Continuing implementation (turn ${turns + 1})`);
      callbacks?.onTurnStart?.(turns + 1);
      const response = await chatTurn();
      if (!response) break;
      turns += 1;
      callbacks?.onTurnEnd?.(turns);

      if (response.toolCalls.length === 0) {
        const content = response.content || '';
        if (!content.trim()) {
          blankNudges += 1;
          if (blankNudges <= STALL_NUDGE_LIMIT) {
            emergencyMessage(CONTINUE_NUDGE);
            continue;
          }

          finalMessage = 'Paused because the model returned an empty response. Your workspace changes are preserved; send a follow-up to continue.';
          interrupted = true;
          appendMessages([{ role: 'assistant', content: finalMessage }]);
          status('blocked', 'Model returned empty responses');
          break;
        }
        if (isProviderProblem(content)) {
          blankNudges += 1;
          if (blankNudges > STALL_NUDGE_LIMIT) {
            finalMessage = content || 'Provider failure without a final report.';
            status('failed', 'Provider failed repeatedly; task unfinished');
            break;
          }
          emergencyMessage(CONTINUE_NUDGE);
          continue;
        }

        if (isInterimActionNarration(content)) {
          if (interimResponseNudges < MAX_INTERIM_RESPONSE_NUDGES) {
            interimResponseNudges += 1;
            appendMessages([{ role: 'assistant', content }]);
            emergencyMessage(INTERIM_ACTION_NUDGE);
            continue;
          }

          finalMessage = 'Paused because the model described a next action but did not execute it. Send a follow-up to continue, or switch to a model that supports tool calls.';
          interrupted = true;
          appendMessages([{ role: 'assistant', content: finalMessage }]);
          status('blocked', 'Model did not execute its stated next action');
          break;
        }

        // A final text answer ends the task. Verification, when applicable, is
        // recorded and reported as information only: it never re-opens the loop,
        // never asks for repairs, and never triggers unrelated investigation.
        if (shouldRunVerification()) {
          await runVerificationRound();
        }

        appendMessages([{ role: 'assistant', content }]);
        finalMessage = content || 'No response';
        status('completed', 'Task completed');
        break;
      }

      appendMessages([{
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls,
      }]);

      // Safe parallel batch: only read-only tools, no duplicate calls, and the
      // whole batch fits inside the tool-call budget. Results are committed in
      // the original order so call IDs stay deterministically associated.
      const signatures = response.toolCalls.map(callSignature);
      const canRunParallel = response.toolCalls.length > 1
        && toolsUsed + response.toolCalls.length <= maxToolCalls
        && response.toolCalls.every(call => PARALLEL_SAFE_TOOLS.has(call.function.name))
        && new Set(signatures).size === signatures.length;
      if (canRunParallel) {
        const prepared = await Promise.all(response.toolCalls.map(call => executeToolCall(call)));
        for (let index = 0; index < response.toolCalls.length; index++) {
          commitToolResult(response.toolCalls[index]!, prepared[index]!);
        }
        blankNudges = 0;
        interimResponseNudges = 0;
        if (tracker.getChangedFiles().length !== lastChangeCount) {
          lastChangeCount = tracker.getChangedFiles().length;
          stagnantTurns = 0;
        } else {
          stagnantTurns += 1;
          if (stagnantTurns >= STAGNANT_TURN_LIMIT) {
            stagnantTurns = 0;
            emergencyMessage(
              'No changed files for several turns. Reassess your plan, run verification with run_checks, or state precisely what blocks completion.',
            );
          }
        }
        continue;
      }

      let repeatedCall: NvidiaToolCall | undefined;
      let toolLimitReached = false;
      for (let callIndex = 0; callIndex < response.toolCalls.length; callIndex++) {
        const toolCall = response.toolCalls[callIndex]!;
        if (toolsUsed >= maxToolCalls) {
          toolLimitReached = true;
          await flushToolCall(
            toolCall,
            JSON.stringify({
              success: false,
              failed: true,
              errorCode: 'tool_call_limit',
              message: `Not executed: this request reached the limit of ${maxToolCalls} tool calls.`,
              hint: 'Send a follow-up to continue the remaining task.',
            }),
            false,
          );
          continue;
        }
        const signature = callSignature(toolCall);
        if (signature !== lastToolCallSignature) {
          signatureUses.clear();
          lastToolCallSignature = signature;
        }
        const uses = (signatureUses.get(signature) ?? 0) + 1;
        signatureUses.set(signature, uses);
        if (uses >= REPEAT_CALL_LIMIT) {
          repeatedCall = toolCall;
          await flushToolCall(toolCall, repeatedFailureOutput(toolCall.function.name, toolCall.function.arguments), false);
          for (const skippedCall of response.toolCalls.slice(callIndex + 1)) {
            await flushToolCall(
              skippedCall,
              JSON.stringify({
                success: false,
                failed: true,
                errorCode: 'tool_batch_stopped',
                message: 'Not executed because the agent stopped after detecting a repeated tool call.',
                hint: 'Send a follow-up to continue the remaining task.',
              }),
              false,
            );
          }
          break;
        }
        const blocked = response.toolCalls.length === 1 && signature === lastFailedSignature
          ? repeatedFailureOutput(toolCall.function.name, toolCall.function.arguments)
          : undefined;
        const callFailed = await flushToolCall(toolCall, blocked);
        if (response.toolCalls.length === 1) {
          lastFailedSignature = callFailed ? signature : '';
        }
      }
      blankNudges = 0;

      if (repeatedCall) {
        interrupted = true;
        finalMessage = `Stopped: the same tool call (${repeatedCall.function.name}) repeated ${REPEAT_CALL_LIMIT} times without progress. Send a follow-up with different instructions to continue.`;
        status('blocked', 'Stopped repeated tool calls');
        break;
      }

      interimResponseNudges = 0;

      if (toolLimitReached || toolsUsed >= maxToolCalls) {
        interrupted = true;
        finalMessage = `Stopped: this request reached the limit of ${maxToolCalls} tool calls. Send a follow-up to continue if there is more to do.`;
        appendMessages([{ role: 'assistant', content: finalMessage }]);
        status('blocked', 'Tool-call limit reached');
        break;
      }

      if (tracker.getChangedFiles().length !== lastChangeCount) {
        lastChangeCount = tracker.getChangedFiles().length;
        stagnantTurns = 0;
      } else {
        stagnantTurns += 1;
        if (stagnantTurns >= STAGNANT_TURN_LIMIT) {
          stagnantTurns = 0;
          emergencyMessage(
            'No changed files for several turns. Reassess your plan, run verification with run_checks, or state precisely what blocks completion.',
          );
        }
      }
    }

    if (signal?.aborted) {
      interrupted = true;
      status('cancelled', 'Task cancelled by user');
      return { ...resultState(), phase: 'cancelled' };
    }
    return resultState();
  } catch (error) {
    if (signal?.aborted) {
      interrupted = true;
      status('cancelled', 'Task cancelled by user');
      return { ...resultState(), phase: 'cancelled' };
    }
    finalMessage = error instanceof Error ? error.message : String(error);
    status('failed', 'Agent loop failed');
    return { ...resultState(), phase: 'failed' };
  }

  function shouldRunVerification(): boolean {
    if (autoVerifyKinds.length === 0) return false;
    const files = tracker.getChangedFiles();
    if (files.length === 0) return false;
    // An edit outside the project's language(s) or a static asset cannot be
    // covered by the project's typecheck/test command. Running them anyway is
    // how unrelated failures hijack a simple task.
    if (!hasVerifiableChanges(files, ecosystem)) return false;
    // Recorded evidence (from this loop or from run_checks/run_tests) already
    // covers the current changes; the tracker clears it on the next write.
    return tracker.getVerification().length === 0;
  }
}

export function summarizeVerification(results: CheckResult[]): string {
  const parts = results.map(result =>
    `${result.name}: ${result.preExisting === true ? 'pre-existing failure' : result.status}`);
  return `Verification: ${parts.length ? parts.join(', ') : 'none'}`;
}
