import { useState, useEffect, useMemo, useRef } from "react";
import { spawn } from "node:child_process";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { TextareaRenderable, HostClipboardService } from "@opentui/core";
import { createHostClipboard } from "@opentui/core";
import { Header } from "./Header";
import { Footer } from "./Footer";
import { MessageList, type Message } from "./MessageList";
import { CopyMessage } from "../components/ui/message";
import { CommandPopup, filterCommands, type Command } from "./popups/commands";
import { UpdatesPopup, type UpdatePopupStatus } from "./popups/updates";
import { loadConfig, saveConfig } from "../config";
import {
  createSession,
  deleteSession,
  hasUserMessage,
  loadSessions,
  pruneEmptySessions,
  saveSession,
  type ChatSession,
} from "../layers/sessions/storage";
import { checkForUpdate, getInstalledVersion } from "../updateChecker";
import { listNvidiaModels, chatNvidia, type NvidiaChatMessage } from "../providers/nvidia";
import { listOpenAIModels, chatOpenAI } from "../providers/openai";
import { listGoogleModels, chatGoogle } from "../providers/google";
import { listAnthropicModels, chatAnthropic } from "../providers/anthropic";
import { listXaiModels, chatXai } from "../providers/xai";
import { formatTokenCount } from "../token-format";
import { chatDash, getDashQuota } from "../providers/dash";
import { getDeviceId } from "../device";
import {
  clampCompactPercent,
  computePromptBudget,
  resolveModelCapacity,
  type ModelCapacity,
} from "../context-window";

const DASH_BACKEND_URL = 'https://neuro-dash-backend-production.up.railway.app/';

async function fetchModelsFromDashBackend(): Promise<Array<{ id: string; name: string; capacity?: ModelCapacity }>> {
  const res = await fetch(`${DASH_BACKEND_URL}/api/models`);
  if (!res.ok) throw new Error(`DASH backend returned HTTP ${res.status}`);
  const data = await res.json() as { models?: unknown };
  if (!data || !Array.isArray(data.models)) throw new Error('DASH backend returned an invalid model list');
  return data.models
    .filter((model): model is { id: string; name: string; contextWindow?: number; maxOutputTokens?: number } => (
      Boolean(model)
      && typeof model === 'object'
      && typeof (model as { id?: unknown }).id === 'string'
      && (model as { id: string }).id.length > 0
    ))
    .map((model) => {
      const contextWindow = Number(model.contextWindow);
      const maxOutputTokens = Number(model.maxOutputTokens);
      const capacity = Number.isFinite(contextWindow) && contextWindow > 0
        ? {
            contextWindow,
            maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 0,
          }
        : undefined;
      return {
        id: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        ...(capacity ? { capacity } : {}),
      };
    });
}

import { agentTools, executeAgentTool, selectAgentToolsForTask, type AgentTodo, type ToolContext } from "../layers/agent/tools";
import { MentionMenu } from "./MentionMenu";
import { collectMentionedContext, findMentionSuggestions, getActiveMention, replaceMention, resolveMentionPopupWidth } from "./mentions";
import { buildCapabilityRegistry } from "../layers/agent/capabilities";
import type { ToolDefinitionLike } from "../layers/agent/capabilities";
import {
  callMcpTool,
  connectMcpServer,
  connectedMcpTools,
  mcpServersToAutoConnect,
  parseMcpAddCommand,
  parseMcpAddHttpCommand,
  selectToolsWithinProviderLimit,
  type ConnectedMcpServer,
  type McpServerConfig,
} from "../layers/agent/mcp";
import { createAgentSystemMessage } from "../layers/agent/system-prompt";
import { formatSkillCatalog, listSkills } from "../layers/agent/skills";
import { filterToolsForMode, isToolAllowedInMode, modeInstructions, parseAgentMode, resolveAgentMode } from "../layers/agent/modes";
import { runAgentLoop, type AgentPhase } from "../layers/agent/loop";
import { TaskTracker } from "../layers/agent/taskstate";
import { ReadLedger } from "../layers/agent/read-ledger";
import { resolveTaskObjective } from "../layers/agent/continuation";
import * as systemPrompt from "../../system-prompt.json";
import { colors } from "./theme";
import { TodoBar } from "./TodoBar";
import {
  ApiKeyPopup,
  ModelsPopup,
  MODELS_VISIBLE_ROWS,
  buildVisibleModelGroups,
  flattenModelGroups,
  isProviderHeaderRow,
  providerNameAtModelIndex,
  SessionsPopup,
  TodosPopup,
  PendingRequestPopup,
  ProvidersPopup,
  McpPopup,
  type PendingRequest,
} from "./popups";

type ProviderModel = {
  provider: string;
  models: string[];
  displayNames?: Record<string, string>;
  capacities?: Record<string, ModelCapacity>;
};

type ProviderId = 'nvidia' | 'openai' | 'google' | 'anthropic' | 'xai' | 'dash';

const PROVIDER_IDS: Record<string, ProviderId> = {
  NVIDIA: 'nvidia',
  OPENAI: 'openai',
  GOOGLE: 'google',
  ANTHROPIC: 'anthropic',
  XAI: 'xai',
  DASH: 'dash',
};

const PROVIDERS = [
  { id: 'nvidia', name: 'NVIDIA', description: 'NVIDIA API' },
  { id: 'openai', name: 'OpenAI', description: 'OpenAI API' },
  { id: 'google', name: 'Google', description: 'Google Gemini API' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude API' },
  { id: 'xai', name: 'xAI', description: 'Grok API' },
];

// Textarea sizing is in terminal rows, never pixels.
const MIN_INPUT_HEIGHT = 4;
const MAX_INPUT_HEIGHT = 15;

function clampInputHeight(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MIN_INPUT_HEIGHT;
  return Math.min(Math.max(MIN_INPUT_HEIGHT, Math.floor(n)), MAX_INPUT_HEIGHT);
}

// `window` does not exist in a terminal runtime, so open URLs via the OS.
function openUrl(url: string): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
        : process.platform === 'darwin'
          ? spawn('open', [url], { stdio: 'ignore', detached: true })
          : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser available */ });
    child.unref();
  } catch {
    /* ignore */
  }
}

const PHASE_LABELS: Record<AgentPhase, string> = {
  planning: 'Inspecting task and project',
  // The agent phase only means a model turn is active; concrete tool actions
  // are shown by toolActivityLabel when a tool call actually begins.
  executing: 'Thinking',
  verifying: 'Running verification checks',
  repairing: 'Diagnosing and repairing failures',
  completed: 'Task completed',
  blocked: 'Paused: needs your input',
  cancelled: 'Task stopped',
  failed: 'Task failed',
};

function isDiffOutput(output: string): boolean {
  const trimmed = output.trimStart();
  return trimmed.startsWith('@@ ') || trimmed === '(no change)';
}

function toolOutputPreview(output: string): string {
  const lines = output.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 4) return output;
  return `${lines.slice(0, 4).join('\n')}\n… (${lines.length - 4} more lines; use read_file or search_files for detail)`;
}

function toolActivityLabel(toolName: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawArgs || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch { /* Tool execution reports malformed arguments. */ }

  const filePath = typeof args.path === 'string'
    ? args.path
    : Array.isArray(args.files)
      ? String((args.files[0] as Record<string, unknown> | undefined)?.path ?? '')
      : '';
  const safePath = filePath.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
  const withPath = (activity: string) => safePath ? `${activity}: ${safePath}` : activity;

  switch (toolName) {
    case 'read_file': {
      const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 1;
      const limit = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : 200;
      const requestedRange = args.offset !== undefined || args.limit !== undefined;
      return withPath(requestedRange ? `Reading lines ${offset}–${offset + limit - 1}` : 'Reading file');
    }
    case 'read_many': return `Reading ${Array.isArray(args.files) ? args.files.length : 'multiple'} files`;
    case 'create_file': return withPath('Creating file');
    case 'read_session_activity': return 'Reviewing recent activity';
    case 'get_execution_history': return 'Reviewing action history';
    case 'read_memory': return 'Reading memory';
    case 'write_memory': return 'Updating memory';
    case 'write_file': return withPath('Writing file');
    case 'edit_file':
    case 'multi_edit': return withPath('Editing file');
    case 'multi_file_edit': return withPath('Editing files');
    case 'create_directory': return withPath('Creating directory');
    case 'delete_file': {
      const action = args.action === 'move' ? 'Moving' : args.action === 'rename' ? 'Renaming' : 'Deleting';
      return withPath(`${action} file`);
    }
    case 'list_files': return withPath('Listing files');
    case 'get_file_info': return withPath('Inspecting file');
    case 'find_files':
    case 'glob': return 'Finding files';
    case 'search_files':
    case 'grep':
    case 'code_search': return 'Searching code';
    case 'web_search': return 'Searching the web';
    case 'web_fetch': return 'Reading webpage';
    case 'run_command':
    case 'execute_command': return 'Running command';
    case 'run_background':
      return args.action === 'read' ? 'Reading command output' : args.action === 'kill' ? 'Stopping background task' : 'Starting background task';
    case 'run_checks':
    case 'get_diagnostics': return 'Running checks';
    case 'run_tests': return 'Running tests';
    case 'verify_runtime': return 'Checking app startup';
    case 'ask_user': return 'Waiting for your input';
    case 'todo_write':
    case 'update_task_plan': return 'Updating task plan';
    case 'inspect_project':
    case 'get_project_map': return 'Inspecting project';
    case 'get_project_scripts': return 'Inspecting project scripts';
    case 'get_workspace_index': return 'Checking workspace index';
    case 'refresh_workspace_index': return 'Updating workspace index';
    case 'skill_loader': return 'Loading instructions';
    case 'apply_patch': return 'Applying changes';
    case 'git_tool': {
      const action = typeof args.action === 'string' ? args.action : '';
      if (action === 'commit') return 'Committing changes';
      if (action === 'branch' || action === 'checkout') return 'Updating Git branch';
      return action === 'log' ? 'Reviewing Git history' : 'Checking Git changes';
    }
    case 'git_status':
    case 'git_diff': return 'Checking Git changes';
    case 'undo_checkpoint': return args.action === 'rollback' ? 'Restoring checkpoint' : 'Saving checkpoint';
    case 'get_check_results': return 'Reviewing verification results';
    case 'get_task_status': return 'Reviewing task progress';
    case 'get_changed_files': return 'Reviewing changed files';
    case 'get_agent_knowledge': return 'Looking up guidance';
    case 'lsp': {
      const operation = typeof args.operation === 'string' ? args.operation : '';
      if (operation === 'definition') return 'Finding definition';
      if (operation === 'references') return 'Finding references';
      if (operation === 'hover') return 'Inspecting symbol';
      return 'Exploring code symbols';
    }
    default: {
      const readableName = toolName.replace(/[_-]+/g, ' ').trim();
      if (!readableName) return 'Working';
      const action = toolName.split(/[_-]+/, 1)[0]?.toLowerCase();
      const detail = toolName.split(/[_-]+/).slice(1).join(' ');
      if (action === 'create') return `Creating${detail ? ` ${detail}` : ''}`;
      if (action === 'read' || action === 'load') return `Reading${detail ? ` ${detail}` : ''}`;
      if (action === 'write' || action === 'save') return `Writing${detail ? ` ${detail}` : ''}`;
      if (action === 'update' || action === 'refresh') return `Updating${detail ? ` ${detail}` : ''}`;
      if (action === 'find' || action === 'search') return `Finding${detail ? ` ${detail}` : ''}`;
      if (action === 'inspect' || action === 'get') return `Inspecting${detail ? ` ${detail}` : ''}`;
      return `Using ${readableName}`;
    }
  }
}

function structuredFailureMessage(output: string): string {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (parsed.success === false || parsed.failed === true) {
      const code = typeof parsed.errorCode === 'string' ? `[${parsed.errorCode}] ` : '';
      const message = typeof parsed.message === 'string' ? parsed.message : 'Tool failed.';
      const hint = typeof parsed.hint === 'string' ? `\n${parsed.hint}` : '';
      return `${code}${message}${hint}`;
    }
  } catch { /* Not structured output. */ }
  return output;
}

function fileMutationDisplay(output: string): string {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    // Keep creation content available to the diff renderer instead of replacing
    // the structured result with the one-line "File created." message.
    if (parsed.operation === 'create' && typeof parsed.content === 'string') return output;
    if (typeof parsed.diff === 'string' && parsed.diff.length > 0) return parsed.diff;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch { /* Not structured output. */ }
  return output;
}

function readPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readPositiveNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.trunc(parsed));
}

function createSystemMessage(mode?: string, tools: readonly ToolDefinitionLike[] = agentTools): NvidiaChatMessage {
  const skillCatalog = formatSkillCatalog(listSkills(process.cwd()));
  return {
    role: 'system',
    content: createAgentSystemMessage(systemPrompt, buildCapabilityRegistry(tools), {
      modeInstructions: modeInstructions(mode),
      skillCatalog,
    }),
  };
}

function getInitialSessions(): { sessions: ChatSession[]; active: ChatSession } {
  const sessions = pruneEmptySessions();
  const active = createSession();
  return { sessions: [active, ...sessions], active };
}

export function App() {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  // Safely get terminal dimensions with fallback
  const terminalWidth = Number.isFinite(dims?.width) && dims.width > 0 ? dims.width : 80;
  const terminalHeight = Number.isFinite(dims?.height) && dims.height > 0 ? dims.height : 24;
  const [initialSessionState] = useState(getInitialSessions);
  const [sessions, setSessions] = useState(initialSessionState.sessions);
  const [activeSessionId, setActiveSessionId] = useState(initialSessionState.active.id);
  const [messages, setMessages] = useState<Message[]>(initialSessionState.active.messages);
  const [input, setInput] = useState('');
  const [inputResetKey, setInputResetKey] = useState(0);
  const [mentionCursor, setMentionCursor] = useState(0);
  const composerRef = useRef<TextareaRenderable | null>(null);
  const hostClipboardRef = useRef<HostClipboardService | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const recallIndexRef = useRef(-1);
  const draftInputRef = useRef('');
  const recallingRef = useRef(false);
  const [tokens, setTokens] = useState(0);
  const [tokensEstimated, setTokensEstimated] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [dashQuota, setDashQuota] = useState<{ used: number; limit: number; estimated?: boolean } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState('');
  const [taskRunning, setTaskRunning] = useState(false);
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [todosPopupOpen, setTodosPopupOpen] = useState(false);
  const [todoScrollTop, setTodoScrollTop] = useState(0);
  const [todoSelected, setTodoSelected] = useState(0);
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [stopArmed, setStopArmed] = useState(false);
  const messageIdRef = useRef(initialSessionState.active.messages.reduce((max, message) => Math.max(max, message.id ?? 0), 0));
  const preserveSessionOrderOnSwitchRef = useRef(false);
  const sendingRef = useRef(false);
  const activeTaskRef = useRef<AbortController | null>(null);
  const mcpConnectionsRef = useRef<Map<string, ConnectedMcpServer>>(new Map());
  const mcpStartupAttemptedRef = useRef(false);
  const taskTrackerRef = useRef<TaskTracker | undefined>(undefined);
  const readLedgerRef = useRef<ReadLedger>(new ReadLedger());
  const conversationRef = useRef<NvidiaChatMessage[]>([
    createSystemMessage(),
    ...initialSessionState.active.conversation.filter(message => message.role !== 'system'),
  ]);
  const [config, setConfig] = useState(loadConfig());
  const [models, setModels] = useState<string[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [awaitingApiKey, setAwaitingApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [modelsPopupOpen, setModelsPopupOpen] = useState(false);
  const [modelCursor, setModelCursor] = useState(0);
  const [modelScrollTop, setModelScrollTop] = useState(0);
  const [modelsSearch, setModelsSearch] = useState('');

  // Structured provider models: [{ provider: string, models: string[] }]
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  // Flat list of model names for cursor navigation (includes provider header rows)
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [sessionsPopupOpen, setSessionsPopupOpen] = useState(false);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [sessionOrderIds, setSessionOrderIds] = useState<string[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [requestChoiceIndex, setRequestChoiceIndex] = useState(0);
  const [updatesPopupShown, setUpdatesPopupShown] = useState(false);
  const [updatesPopupOpen, setUpdatesPopupOpen] = useState(false);
  const [mcpPopupOpen, setMcpPopupOpen] = useState(false);
  const [mcpGuideOpen, setMcpGuideOpen] = useState(false);
  const [mcpCursor, setMcpCursor] = useState(0);
  const [mcpRevision, setMcpRevision] = useState(0);
  const [mcpBusyServer, setMcpBusyServer] = useState<string>();
  const [updateInfo, setUpdateInfo] = useState<{ installed: string; latest: string } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdatePopupStatus>('checking');
  const [updateError, setUpdateError] = useState('');
  const [providersPopupOpen, setProvidersPopupOpen] = useState(false);
  const [providerCursor, setProviderCursor] = useState(0);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [currentProvider, setCurrentProvider] = useState<ProviderId>('nvidia');
  const [activeModel, setActiveModel] = useState<{ provider: ProviderId; model: string } | null>(
    () => {
      const savedActive = (config as any).activeModel as { provider?: unknown; model?: unknown } | undefined;
      const providerIds: readonly ProviderId[] = ['dash', 'nvidia', 'openai', 'google', 'anthropic', 'xai'];
      if (
        savedActive
        && typeof savedActive.provider === 'string'
        && (providerIds as readonly string[]).includes(savedActive.provider)
        && typeof savedActive.model === 'string'
        && savedActive.model
      ) {
        return {
          provider: savedActive.provider as ProviderId,
          model: savedActive.model,
        };
      }
      for (const p of providerIds) {
        const saved = (config.providers as any)?.[p]?.model;
        if (saved) return { provider: p, model: saved };
      }
      return null;
    },
  );

  // Always a finite, positive integer, even if state ever gets corrupted.
  const safeInputHeight = clampInputHeight(inputHeight);
  // Composer width: box marginX (2*2) + paddingX (1*2) = 6 columns of chrome.
  const composerWidth = Math.max(1, terminalWidth - 6);

  const activeMention = getActiveMention(input, composerRef.current?.cursorOffset ?? input.length);
  const mentionSuggestions = useMemo(
    () => activeMention ? findMentionSuggestions(process.cwd(), activeMention.query) : [],
    [activeMention?.query],
  );
  const safeMentionIndex = Math.min(mentionCursor, Math.max(0, mentionSuggestions.length - 1));
  const showCommands = input.startsWith('/') && !/^\/mcp\s/i.test(input);
  const filteredCommands = filterCommands(input);
  const safeCommandIndex = Math.min(commandIndex, Math.max(0, filteredCommands.length - 1));
  const mcpServerConfigs: McpServerConfig[] = Array.isArray((config as any).mcp?.servers)
    ? (config as any).mcp.servers
    : [];
  const mcpServerRows = useMemo(() => mcpServerConfigs.map(server => {
    const connection = mcpConnectionsRef.current.get(server.name.toLowerCase());
    return {
      config: server,
      enabled: server.enabled !== false,
      connected: Boolean(connection),
      toolCount: connection?.tools.length ?? 0,
    };
  }), [config, mcpRevision]);
  const safeMcpCursor = Math.min(mcpCursor, Math.max(0, mcpServerRows.length - 1));

  useEffect(() => {
    setMentionCursor(0);
  }, [activeMention?.query]);

  const activeSession = sessions.find(session => session.id === activeSessionId) ?? initialSessionState.active;
  const openableSessions = sessions.filter(hasUserMessage);
  const sortSessionsNewestFirst = (items: ChatSession[]) => [...items].sort((a, b) => {
    const timeDifference = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return Number.isNaN(timeDifference) || timeDifference === 0
      ? a.id.localeCompare(b.id)
      : timeDifference;
  });
  const sessionPopupSessions = sessionOrderIds
    .map(id => openableSessions.find(session => session.id === id))
    .filter((session): session is ChatSession => Boolean(session));
  const buildUpdatedSession = (preserveUpdatedAt = false): ChatSession => {
    const firstUserMessage = messages.find(message => message.role === 'user')?.content?.trim();
    return {
      ...activeSession,
      title: activeSession.title === 'New chat' && firstUserMessage
        ? firstUserMessage.slice(0, 72)
        : activeSession.title,
      updatedAt: preserveUpdatedAt ? activeSession.updatedAt : new Date().toISOString(),
      messages,
      conversation: conversationRef.current.filter(message => message.role !== 'system'),
    };
  };

  useEffect(() => {
    const seeded: string[] = [];
    for (const session of sessions) {
      for (const message of session.messages) {
        const content = typeof message.content === 'string' ? message.content.trim() : '';
        if (message.role === 'user' && content && !content.startsWith('/')) {
          if (seeded.at(-1) !== content) seeded.push(content);
        }
      }
    }
    inputHistoryRef.current = seeded.slice(-100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!taskTrackerRef.current) {
      const tracker = new TaskTracker(process.cwd(), initialSessionState.active.id);
      taskTrackerRef.current = tracker;
      setTodos(tracker.toTodos());
    }
  }, [initialSessionState.active.id]);

  useEffect(() => () => {
    for (const connection of mcpConnectionsRef.current.values()) {
      void connection.client.close().catch(() => {});
    }
    mcpConnectionsRef.current.clear();
  }, []);

  useEffect(() => {
    if (mcpStartupAttemptedRef.current) return;
    mcpStartupAttemptedRef.current = true;
    const savedServers: McpServerConfig[] = Array.isArray((config as any).mcp?.servers)
      ? (config as any).mcp.servers
      : [];
    const autoConnect = mcpServersToAutoConnect(savedServers);
    if (autoConnect.length === 0) return;
    void Promise.all(autoConnect.map(async server => {
      try {
        const connection = await connectMcpServer(server, process.cwd());
        mcpConnectionsRef.current.set(server.name.toLowerCase(), connection);
      } catch (error) {
        postMcpNotice(`Could not reconnect MCP server "${server.name}": ${error instanceof Error ? error.message : String(error)}. Open /mcp to retry.`);
      }
    })).finally(() => setMcpRevision(revision => revision + 1));
  }, []);

  useEffect(() => {
    if (!modelsPopupOpen) {
      setModelsSearch('');
      setModelCursor(0);
      setModelScrollTop(0);
    }
  }, [modelsPopupOpen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await checkForUpdate();
        if (cancelled) return;
        if (result.hasUpdate && result.latest) {
          setUpdateInfo({ installed: result.installed, latest: result.latest });
          setUpdateStatus('available');
          if (!updatesPopupShown) {
            setUpdatesPopupShown(true);
            setUpdatesPopupOpen(true);
          }
        }
      } catch {
        // silently ignore
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Migrate legacy NVIDIA model ids once an NVIDIA key is configured.
    if (config.providers?.nvidia?.apiKey) {
      const savedModel = config.providers.nvidia.model;
      if (
        savedModel === 'nvidia/nemotron-3-128k' ||
        savedModel === 'meta/llama-3.1-8b-instruct' ||
        savedModel === 'nvidia/nemotron-3-nano-30b-a3b'
      ) {
        const migratedConfig = {
          ...config,
          providers: {
            ...config.providers,
            nvidia: { ...config.providers.nvidia, model: '' },
          },
        };
        setConfig(migratedConfig);
        saveConfig(migratedConfig);
      }
    }

    // Fetch models from all configured providers for initial load. DASH is
    // always available (no API key needed) and supplies the default model so a
    // first run can send a request without opening /models.
    const fetchInitialModels = async () => {
      // DASH models (always available)
      try {
        const dashModels = await fetchModelsFromDashBackend();
        const list = dashModels.map(m => m.id);
        setModels(list);
        const displayNames: Record<string, string> = {};
        const capacities: Record<string, ModelCapacity> = {};
        dashModels.forEach(m => {
          displayNames[m.id] = m.name;
          if (m.capacity) capacities[m.id] = m.capacity;
        });
        setProviderModels(prev => [...prev.filter(entry => entry.provider !== 'DASH'), { provider: 'DASH', models: list, displayNames, capacities }]);

        // With no usable saved selection, start on the backend's first model so
        // the user can send a request immediately without opening /models.
        // A non-DASH selection only counts when its provider still has a key.
        setActiveModel(current => {
          if (current) {
            if (current.provider === 'dash') {
              if (list.includes(current.model)) return current;
            } else if (config.providers?.[current.provider]?.apiKey) {
              return current;
            }
          }
          return list[0] ? { provider: 'dash', model: list[0] } : current;
        });

        const currentSaved = config.providers?.nvidia?.model;
        const savedIndex = list.findIndex(m => m === currentSaved);
        setModelIndex(savedIndex >= 0 ? savedIndex : 0);
      } catch {}

      // NVIDIA models
      if (config.providers?.nvidia?.apiKey) {
        try {
          const nvidiaModels = await listNvidiaModels(config.providers.nvidia.apiKey);
          if (nvidiaModels.length > 0) {
            setProviderModels(prev => [...prev.filter(entry => entry.provider !== 'NVIDIA'), { provider: 'NVIDIA', models: nvidiaModels }]);
          }
        } catch {}
      }

      // OpenAI models
      if (config.providers?.openai?.apiKey) {
        try {
          const openaiModels = await listOpenAIModels(config.providers.openai.apiKey);
          if (openaiModels.length > 0) {
            setProviderModels(prev => [...prev.filter(entry => entry.provider !== 'OPENAI'), { provider: 'OPENAI', models: openaiModels }]);
          }
        } catch {}
      }

      // Google models
      if (config.providers?.google?.apiKey) {
        try {
          const googleModels = await listGoogleModels(config.providers.google.apiKey);
          if (googleModels.length > 0) {
            setProviderModels(prev => [...prev.filter(entry => entry.provider !== 'GOOGLE'), { provider: 'GOOGLE', models: googleModels }]);
          }
        } catch {}
      }

      // Anthropic models
      if (config.providers?.anthropic?.apiKey) {
        try {
          const anthropicModels = await listAnthropicModels(config.providers.anthropic.apiKey);
          if (anthropicModels.length > 0) {
            setProviderModels(prev => [...prev.filter(entry => entry.provider !== 'ANTHROPIC'), { provider: 'ANTHROPIC', models: anthropicModels }]);
          }
        } catch {}
      }

      // xAI models
      if (config.providers?.xai?.apiKey) {
        try {
          const xaiModels = await listXaiModels(config.providers.xai.apiKey);
          if (xaiModels.length > 0) {
            setProviderModels(prev => [...prev.filter(entry => entry.provider !== 'XAI'), { provider: 'XAI', models: xaiModels }]);
          }
        } catch {}
      }
    };

    fetchInitialModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.providers?.nvidia?.apiKey, config.providers?.openai?.apiKey, config.providers?.google?.apiKey, config.providers?.anthropic?.apiKey, config.providers?.xai?.apiKey]);

  useEffect(() => {
    if (!messages.some(message => message.role === 'user')) return;
    const preserveUpdatedAt = preserveSessionOrderOnSwitchRef.current;
    preserveSessionOrderOnSwitchRef.current = false;
    const updatedSession = buildUpdatedSession(preserveUpdatedAt);
    const timer = setTimeout(() => {
      saveSession(updatedSession);
      setSessions(current => [updatedSession, ...current.filter(session => session.id !== updatedSession.id)]);
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, messages]);

  useEffect(() => {
    setCommandIndex(0);
  }, [input]);

  const refreshDashQuota = () => {
    void getDashQuota().then(quota => {
      if (!quota) {
        setDashQuota(null);
        return;
      }
      setDashQuota({
        used: quota.used,
        limit: quota.limit,
        ...(quota.estimated ? { estimated: true } : {}),
      });
    });
  };

  // DASH quota is device-scoped and only meaningful while a DASH model is
  // selected. Other providers never touch the backend ledger.
  useEffect(() => {
    setContextTokens(0);
    if (activeModel?.provider !== 'dash') {
      setDashQuota(null);
      return;
    }
    refreshDashQuota();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModel?.provider, activeModel?.model]);

  const currentModel = activeModel?.model ?? '';
  const dashModelsEntry = providerModels.find(entry => entry.provider === 'DASH');
  const dashCapacities = dashModelsEntry?.capacities ?? {};
  const dashDisplayNames = dashModelsEntry?.displayNames ?? {};
  const isDashModel = activeModel?.provider === 'dash';
  const activeCapacity = resolveModelCapacity(
    currentModel,
    isDashModel ? dashCapacities[currentModel] : undefined,
  );

  // The popup shows provider groups with DASH first. Filtering happens on every
  // keystroke, so the cursor always indexes the currently visible rows.
  const visibleModelGroups = useMemo(
    () => buildVisibleModelGroups(modelList, modelsSearch, dashModelsEntry?.displayNames),
    [modelList, modelsSearch, dashModelsEntry?.displayNames],
  );
  const filteredModelList = useMemo(
    () => flattenModelGroups(visibleModelGroups),
    [visibleModelGroups],
  );

  useEffect(() => {
    if (!modelsPopupOpen) return;
    const firstModelIndex = filteredModelList.findIndex(model => !isProviderHeaderRow(model));
    setModelCursor(firstModelIndex < 0 ? 0 : firstModelIndex);
    setModelScrollTop(0);
    // Intentionally keyed by the raw inputs; the derived lists are rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsPopupOpen, modelsSearch, modelList]);

  const getSystemMessage = (mode?: string) => createSystemMessage(mode);

  const postMcpNotice = (content: string) => setMessages(current => [...current, { role: 'assistant', content }]);

  const saveMcpServers = (servers: McpServerConfig[]) => {
    const nextConfig = {
      ...(config as any),
      mcp: { ...((config as any).mcp ?? {}), servers },
    };
    setConfig(nextConfig);
    saveConfig(nextConfig);
  };

  const handleMcpCommand = async (command: string): Promise<void> => {
    const servers: McpServerConfig[] = Array.isArray((config as any).mcp?.servers)
      ? (config as any).mcp.servers
      : [];
    const action = /^\/mcp(?:\s+(.*))?$/i.exec(command)?.[1]?.trim() ?? '';
    if (!action || action.toLowerCase() === 'list') {
      setMcpGuideOpen(false);
      setMcpCursor(0);
      setMcpPopupOpen(true);
      return;
    }

    const stdio = parseMcpAddCommand(command);
    if (stdio) {
      if (servers.some(server => server.name.toLowerCase() === stdio.name.toLowerCase())) {
        postMcpNotice(`MCP server "${stdio.name}" already exists. Remove it first or choose another name.`);
        return;
      }
      const nextServer: McpServerConfig = {
        name: stdio.name,
        enabled: false,
        transport: 'stdio',
        command: stdio.command,
        args: stdio.args,
        ...(Object.keys(stdio.env).length ? { env: stdio.env } : {}),
      };
      saveMcpServers([...servers, nextServer]);
      postMcpNotice(`Added MCP server "${stdio.name}". Connect it with /mcp connect ${stdio.name}.`);
      return;
    }

    const http = parseMcpAddHttpCommand(command);
    if (http) {
      if (servers.some(server => server.name.toLowerCase() === http.name.toLowerCase())) {
        postMcpNotice(`MCP server "${http.name}" already exists. Remove it first or choose another name.`);
        return;
      }
      saveMcpServers([...servers, {
        name: http.name,
        enabled: false,
        transport: 'http',
        url: http.url,
        ...(Object.keys(http.headers).length ? { headers: http.headers } : {}),
      }]);
      postMcpNotice(`Added MCP server "${http.name}". Connect it with /mcp connect ${http.name}.`);
      return;
    }

    const match = /^\/mcp\s+(connect|disconnect|remove)\s+([a-z0-9._-]{1,48})$/i.exec(command);
    if (!match) {
      postMcpNotice('Invalid MCP command. Type /mcp to view usage.');
      return;
    }
    const [, verb, serverName] = match;
    const key = serverName!.toLowerCase();
    const server = servers.find(entry => entry.name.toLowerCase() === key);
    const existing = mcpConnectionsRef.current.get(key);
    if (verb!.toLowerCase() === 'connect') {
      if (!server) {
        postMcpNotice(`MCP server "${serverName}" is not configured. Type /mcp to view usage.`);
        return;
      }
      if (existing) {
        saveMcpServers(servers.map(entry => entry.name.toLowerCase() === key ? { ...entry, enabled: true } : entry));
        postMcpNotice(`MCP server "${server.name}" is already connected with ${existing.tools.length} tools.`);
        return;
      }
      try {
        const connected = await connectMcpServer(server, process.cwd());
        mcpConnectionsRef.current.set(key, connected);
        saveMcpServers(servers.map(entry => entry.name.toLowerCase() === key ? { ...entry, enabled: true } : entry));
        setMcpRevision(revision => revision + 1);
        postMcpNotice(`Connected MCP server "${server.name}". ${connected.tools.length} tools are available to the agent.`);
      } catch (error) {
        postMcpNotice(`Could not connect to MCP server "${server.name}": ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (verb!.toLowerCase() === 'disconnect') {
      if (!existing) {
        if (server) saveMcpServers(servers.map(entry => entry.name.toLowerCase() === key ? { ...entry, enabled: false } : entry));
        postMcpNotice(`MCP server "${serverName}" is disconnected and disabled from automatic reconnect.`);
        return;
      }
      await existing.client.close().catch(() => {});
      mcpConnectionsRef.current.delete(key);
      saveMcpServers(servers.map(entry => entry.name.toLowerCase() === key ? { ...entry, enabled: false } : entry));
      setMcpRevision(revision => revision + 1);
      postMcpNotice(`Disconnected MCP server "${existing.config.name}".`);
      return;
    }
    if (!server) {
      postMcpNotice(`MCP server "${serverName}" is not configured.`);
      return;
    }
    if (existing) {
      await existing.client.close().catch(() => {});
      mcpConnectionsRef.current.delete(key);
      setMcpRevision(revision => revision + 1);
    }
    saveMcpServers(servers.filter(entry => entry.name.toLowerCase() !== key));
    postMcpNotice(`Removed MCP server "${server.name}".`);
  };

  const toggleMcpServer = async (server: McpServerConfig) => {
    setMcpBusyServer(server.name);
    try {
      const connected = mcpConnectionsRef.current.has(server.name.toLowerCase());
      await handleMcpCommand(`/mcp ${connected ? 'disconnect' : 'connect'} ${server.name}`);
    } finally {
      setMcpBusyServer(undefined);
    }
  };

  const removeMcpServer = async (server: McpServerConfig) => {
    setMcpBusyServer(server.name);
    try {
      await handleMcpCommand(`/mcp remove ${server.name}`);
      setMcpCursor(index => Math.max(0, Math.min(index, mcpServerRows.length - 2)));
    } finally {
      setMcpBusyServer(undefined);
    }
  };

  const disableMcpServer = async (server: McpServerConfig) => {
    await handleMcpCommand(`/mcp disconnect ${server.name}`);
    setMcpRevision(revision => revision + 1);
  };

  const persistCurrentSession = (preserveUpdatedAt = false): ChatSession | undefined => {
    if (!messages.some(message => message.role === 'user')) return undefined;
    const updatedSession = buildUpdatedSession(preserveUpdatedAt);
    saveSession(updatedSession);
    setSessions(current => [updatedSession, ...current.filter(session => session.id !== updatedSession.id)]);
    return updatedSession;
  };

  const startNewSession = () => {
    persistCurrentSession();
    taskTrackerRef.current = undefined;
    const session = createSession();
    setSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
    setActiveSessionId(session.id);
    setMessages([]);
    conversationRef.current = [createSystemMessage()];
    readLedgerRef.current.clear();
    messageIdRef.current = 0;
    setTokens(0);
    setTokensEstimated(false);
    setContextTokens(0);
    setTodos([]);
    setSessionsPopupOpen(false);
    setInput('');
    setInputHeight(MIN_INPUT_HEIGHT);
    setInputResetKey(key => key + 1);
  };

  const openSessions = () => {
    const persistedSession = persistCurrentSession(true);
    const sessionsToDisplay = persistedSession
      ? [persistedSession, ...openableSessions.filter(session => session.id !== persistedSession.id)]
      : openableSessions;
    setSessionOrderIds(sortSessionsNewestFirst(sessionsToDisplay).map(session => session.id));
    setSessionIndex(0);
    setSessionsPopupOpen(true);
  };

  const selectSession = (sessionId: string) => {
    persistCurrentSession(true);
    const selectedSession = sessions.find(session => session.id === sessionId);
    if (!selectedSession) return;
    preserveSessionOrderOnSwitchRef.current = true;
    const tracker = new TaskTracker(process.cwd(), selectedSession.id);
    taskTrackerRef.current = tracker;
    setActiveSessionId(selectedSession.id);
    setMessages(selectedSession.messages);
    conversationRef.current = [
      getSystemMessage(),
      ...selectedSession.conversation.filter(message => message.role !== 'system'),
    ];
    readLedgerRef.current.clear();
    messageIdRef.current = selectedSession.messages.reduce((max, message) => Math.max(max, message.id ?? 0), 0);
    setTokens(0);
    setTokensEstimated(false);
    setContextTokens(0);
    setTodos(tracker.toTodos());
    setSessionsPopupOpen(false);
    setInput('');
    setInputHeight(MIN_INPUT_HEIGHT);
    setInputResetKey(key => key + 1);
  };

  const deleteSelectedSession = (sessionId = sessionPopupSessions[sessionIndex]?.id) => {
    const target = sessionPopupSessions.find(session => session.id === sessionId);
    if (!target) return;
    deleteSession(target.id);
    const remaining = openableSessions.filter(session => session.id !== target.id);
    const remainingInDisplayedOrder = sessionPopupSessions.filter(session => session.id !== target.id);
    setSessionOrderIds(current => current.filter(id => id !== target.id));
    setSessions(remaining);
    if (target.id === activeSessionId) {
      taskTrackerRef.current?.resetSteps();
      taskTrackerRef.current = undefined;
      if (remaining.length) {
        preserveSessionOrderOnSwitchRef.current = true;
        const next = remainingInDisplayedOrder[0] ?? remaining[0]!;
        setActiveSessionId(next.id);
        setMessages(next.messages);
        conversationRef.current = [
          getSystemMessage(),
          ...next.conversation.filter(message => message.role !== 'system'),
        ];
        readLedgerRef.current.clear();
        messageIdRef.current = next.messages.reduce((max, message) => Math.max(max, message.id ?? 0), 0);
        setTokens(0);
        setTokensEstimated(false);
        setContextTokens(0);
      } else {
        const fresh = createSession();
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
        setMessages([]);
        conversationRef.current = [getSystemMessage()];
        readLedgerRef.current.clear();
        messageIdRef.current = 0;
        setTokens(0);
        setTokensEstimated(false);
        setContextTokens(0);
      }
      setSessionIndex(0);
    }
    setSessionIndex(current => Math.min(current, Math.max(remaining.length - 1, 0)));
    setTodos([]);
    setInput('');
    setInputHeight(MIN_INPUT_HEIGHT);
    setInputResetKey(key => key + 1);
  };

  const waitForUser = (request: Omit<PendingRequest, 'resolve'>, signal?: AbortSignal) => new Promise<string>(resolve => {
    setRequestChoiceIndex(0);
    const finish = (answer: string) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const onAbort = () => {
      setPendingRequest(current => current?.resolve === finish ? null : current);
      finish('cancelled');
    };
    if (signal?.aborted) {
      finish('cancelled');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    setModelsPopupOpen(false);
    setSessionsPopupOpen(false);
    setTodosPopupOpen(false);
    if (input.startsWith('/')) {
      setInput('');
      setInputResetKey(value => value + 1);
    }
    setPendingRequest({ ...request, resolve: finish });
  });

  const resolveUserRequest = (answer: string) => {
    if (!pendingRequest) return;
    const resolve = pendingRequest.resolve;
    setPendingRequest(null);
    resolve(answer);
  };

  const getSessionActivity = (sessionId: string | undefined, limit: number) => {
    const recentSessions = loadSessions();
    if (sessionId === activeSessionId || !sessionId) {
      return JSON.stringify({
        currentSessionId: activeSessionId,
        activity: conversationRef.current.filter(message => message.role !== 'system').slice(-limit),
        availableSessions: recentSessions.slice(0, 10).map(session => ({ id: session.id, title: session.title, updatedAt: session.updatedAt })),
      });
    }
    const savedSession = recentSessions.find(session => session.id === sessionId);
    if (!savedSession) return `No saved session found with id ${sessionId}.`;
    return JSON.stringify({
      id: savedSession.id,
      title: savedSession.title,
      activity: savedSession.conversation.filter(message => message.role !== 'system').slice(-limit),
    });
  };

  const send = async (submittedValue = input) => {
    const trimmed = submittedValue.trim();
    if (!trimmed || sendingRef.current) return;
    sendingRef.current = true;
    let taskTimeout: ReturnType<typeof setTimeout> | undefined;
    let taskController: AbortController | undefined;
    let taskTimedOut = false;
    let liveStreamMessageId: number | null = null;
    setInput('');
    setInputHeight(MIN_INPUT_HEIGHT);
    setInputResetKey(key => key + 1);

    try {
      if (trimmed === '/providers' || trimmed === '/provider') {
        setProvidersPopupOpen(true);
        setProviderCursor(0);
        return;
      }
      if (/^\/mcp(?:\s|$)/i.test(trimmed)) {
        try {
          await handleMcpCommand(trimmed);
        } catch (error) {
          postMcpNotice(`Invalid MCP command: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (trimmed === '/exit') {
        renderer.destroy();
        return;
      }
      if (trimmed === '/updates') {
        setUpdateStatus('checking');
        setUpdateError('');
        setUpdatesPopupOpen(true);
        try {
          const result = await checkForUpdate({ force: true });
          if (result.hasUpdate && result.latest) {
            setUpdateInfo({ installed: result.installed, latest: result.latest });
            setUpdateStatus('available');
          } else {
            setUpdatesPopupOpen(false);
            setTimeout(() => {
              setCopyMessage(result.latest ? `You are up to date! (${result.installed})` : 'Could not check for updates');
            }, 0);
          }
        } catch (error) {
          setUpdateError(error instanceof Error ? error.message : 'Failed to check for updates');
          setUpdateStatus('error');
        }
        return;
      }
      if (trimmed === '/models') {
        setProviderModels([]);
        setModelList([]);
        setModelsSearch('');
        setModelCursor(0);
        setModelScrollTop(0);
        setModelsLoading(true);
        setModelsError(null);
        setModelsPopupOpen(true);

        const fetchAllProviders = async () => {
          // DASH models (always available, with display names)
          try {
            const dashModels = await fetchModelsFromDashBackend();
            const models = dashModels.map(m => m.id);
            const displayNames: Record<string, string> = {};
            const capacities: Record<string, ModelCapacity> = {};
            dashModels.forEach(m => {
              displayNames[m.id] = m.name;
              if (m.capacity) capacities[m.id] = m.capacity;
            });
            setProviderModels(prev => [...prev, { provider: 'DASH', models, displayNames, capacities }]);
            if (models.length > 0) {
              setModelList(prev => [...prev, 'DASH', ...models]);
            } else {
              setModelsError(prev => (prev ? `${prev}\n` : '') + 'The backend returned no approved models');
            }
          } catch (err) {
            console.error('Failed to load models from DASH:', err);
            setModelsError(prev => (prev ? `${prev}\n` : '') + 'Failed to load models from DASH');
          }

          // NVIDIA models
          const nvidiaKey = config.providers?.nvidia?.apiKey;
          if (nvidiaKey) {
            try {
              const models = await listNvidiaModels(nvidiaKey);
              if (models.length > 0) {
                setProviderModels(prev => [...prev, { provider: 'NVIDIA', models }]);
                setModelList(prev => [...prev, 'NVIDIA', ...models]);
              }
            } catch (err) {
              console.error('Failed to load models from NVIDIA:', err);
              setModelsError(prev => (prev ? `${prev}\n` : '') + 'Failed to load models from NVIDIA');
            }
          }

          // OpenAI models
          const openaiKey = config.providers?.openai?.apiKey;
          if (openaiKey) {
            try {
              const models = await listOpenAIModels(openaiKey);
              if (models.length > 0) {
                setProviderModels(prev => [...prev, { provider: 'OPENAI', models }]);
                setModelList(prev => [...prev, 'OpenAI', ...models]);
              }
            } catch (err) {
              console.error('Failed to load models from OpenAI:', err);
              setModelsError(prev => (prev ? `${prev}\n` : '') + 'Failed to load models from OpenAI');
            }
          }

          // Google models
          const googleKey = config.providers?.google?.apiKey;
          if (googleKey) {
            try {
              const models = await listGoogleModels(googleKey);
              if (models.length > 0) {
                setProviderModels(prev => [...prev, { provider: 'GOOGLE', models }]);
                setModelList(prev => [...prev, 'Google', ...models]);
              }
            } catch (err) {
              console.error('Failed to load models from Google:', err);
              setModelsError(prev => (prev ? `${prev}\n` : '') + 'Failed to load models from Google');
            }
          }

          // Anthropic models
          const anthropicKey = config.providers?.anthropic?.apiKey;
          if (anthropicKey) {
            try {
              const models = await listAnthropicModels(anthropicKey);
              if (models.length > 0) {
                setProviderModels(prev => [...prev, { provider: 'ANTHROPIC', models }]);
                setModelList(prev => [...prev, 'ANTHROPIC', ...models]);
              }
            } catch (err) {
              console.error('Failed to load models from Anthropic:', err);
              setModelsError(prev => (prev ? `${prev}\n` : '') + 'Failed to load models from Anthropic');
            }
          }

          // xAI models
          const xaiKey = config.providers?.xai?.apiKey;
          if (xaiKey) {
            try {
              const models = await listXaiModels(xaiKey);
              if (models.length > 0) {
                setProviderModels(prev => [...prev, { provider: 'XAI', models }]);
                setModelList(prev => [...prev, 'XAI', ...models]);
              }
            } catch (err) {
              console.error('Failed to load models from xAI:', err);
              setModelsError(prev => (prev ? `${prev}\n` : '') + 'Failed to load models from xAI');
            }
          }

          setModelsLoading(false);
        };

        fetchAllProviders();
        return;
      }
      if (trimmed === '/new') {
        startNewSession();
        return;
      }
      if (trimmed === '/sessions') {
        openSessions();
        return;
      }
      if (trimmed === '/help') {
        openUrl('https://neuro-corp.com/products/dash/docs');
        return;
      }
      if (trimmed === '/donate') {
        openUrl('https://buymeacoffee.com/neuro_corp');
        return;
      }
      if (trimmed === '/version') {
        setMessages(m => [...m, { role: 'assistant', content: `dash version ${getInstalledVersion()}` }]);
        return;
      }
      if (trimmed === '/mode' || trimmed.startsWith('/mode ')) {
        const requested = trimmed.slice('/mode'.length).trim();
        if (!requested) {
          setMessages(m => [...m, {
            role: 'assistant',
            content: `Agent mode: ${resolveAgentMode((config as any).agent?.mode).toUpperCase()}. Use /mode build, /mode plan, /mode explore, or /mode review.`,
          }]);
          return;
        }
        const nextMode = parseAgentMode(requested);
        if (!nextMode) {
          setMessages(m => [...m, { role: 'assistant', content: 'Unknown mode. Choose build, plan, explore, or review.' }]);
          return;
        }
        const nextConfig = { ...(config as any), agent: { ...((config as any).agent ?? {}), mode: nextMode } };
        setConfig(nextConfig);
        saveConfig(nextConfig);
        setMessages(m => [...m, { role: 'assistant', content: `Agent mode set to ${nextMode.toUpperCase()}.` }]);
        return;
      }

      const priorConversation = conversationRef.current.filter(message => message.role !== 'system');
      const userMsg = { role: 'user' as const, content: trimmed };
      let modelUserContent = trimmed;
      try {
        const mentioned = await collectMentionedContext(process.cwd(), trimmed);
        if (mentioned.content) modelUserContent = `${trimmed}\n\n${mentioned.content}`;
      } catch (error) {
        postMcpNotice(`Could not load mentioned workspace context: ${error instanceof Error ? error.message : String(error)}`);
      }
      const modelUserMessage = { role: 'user' as const, content: modelUserContent };
      const requestedMode = resolveAgentMode((config as any).agent?.mode);
      const connectedBindings = connectedMcpTools(mcpConnectionsRef.current.values());
      const taskDescription = [...priorConversation, userMsg]
        .filter(message => message.role === 'user' && typeof message.content === 'string')
        .map(message => message.content)
        .join('\n');
      const selectedCoreTools = filterToolsForMode(
        selectAgentToolsForTask(agentTools, taskDescription),
        requestedMode,
      );
      const selectedMcpBindings = connectedBindings.filter(binding =>
        isToolAllowedInMode(requestedMode, binding.definition.function.name));
      const boundedToolSet = selectToolsWithinProviderLimit(
        selectedCoreTools,
        selectedMcpBindings,
        taskDescription,
      );
      const taskTools = boundedToolSet.tools;
      const mcpBindingByName = new Map(boundedToolSet.selectedMcpBindings.map(binding => [binding.definition.function.name, binding]));
      setMessages(current => [...current, userMsg]);
      conversationRef.current = [...conversationRef.current, modelUserMessage];
      if (inputHistoryRef.current.at(-1) !== trimmed) {
        inputHistoryRef.current.push(trimmed);
        if (inputHistoryRef.current.length > 100) inputHistoryRef.current = inputHistoryRef.current.slice(-100);
      }
      recallIndexRef.current = -1;
      draftInputRef.current = '';
      const activeProviderId: ProviderId = activeModel?.provider ?? 'nvidia';
      const activeApiKey = activeProviderId === 'dash' ? undefined : (config.providers as any)?.[activeProviderId]?.apiKey;
      const generationConfig = (config as any).generation ?? {};
      const agentConfig = (config as any).agent ?? {};
      // DASH reports the real window; other providers fall back to the local
      // capacity table. The prompt budget is window − output reservation,
      // scaled by the (clamped) compaction threshold.
      const requestCapacity = resolveModelCapacity(
        activeModel?.model ?? '',
        activeProviderId === 'dash' ? dashCapacities[activeModel?.model ?? ''] : undefined,
      );
      const compactPercent = clampCompactPercent(agentConfig.compactPercent);
      const promptBudget = computePromptBudget({
        contextWindow: requestCapacity.contextWindow,
        maxOutputTokens: requestCapacity.maxOutputTokens,
        compactPercent,
        hardCap: readPositiveInteger(agentConfig.maxPromptTokens),
      });
      const reasoningEffort = ['low', 'medium', 'high'].includes(String(generationConfig.reasoningEffort))
        ? String(generationConfig.reasoningEffort) as 'low' | 'medium' | 'high'
        : undefined;
      const generationOptions = {
        maxOutputTokens: readPositiveInteger(generationConfig.maxOutputTokens) ?? 4096,
        temperature: Number.isFinite(Number(generationConfig.temperature)) ? Number(generationConfig.temperature) : undefined,
        topP: readPositiveNumber(generationConfig.topP),
        reasoningEffort,
      };
      const pricing = (config as any).pricing;
      if ((activeApiKey || activeProviderId === 'dash') && activeModel?.model) {
        taskController = new AbortController();
        activeTaskRef.current = taskController;
        setTaskRunning(true);
        setStopArmed(false);
        taskTimeout = setTimeout(() => {
          taskTimedOut = true;
          taskController?.abort('2-hour task limit reached');
        }, 2 * 60 * 60 * 1000);
        if (!taskTrackerRef.current) taskTrackerRef.current = new TaskTracker(process.cwd(), activeSessionId);
        const runTracker = taskTrackerRef.current;
        setTodos(runTracker.toTodos());
        const taskObjective = resolveTaskObjective(trimmed, runTracker);
        const toolContext: ToolContext = {
          workspaceRoot: process.cwd(),
          signal: taskController.signal,
          approve: async (toolName: string, summary: string) =>
            (await waitForUser({ kind: 'approval', prompt: `${toolName}: ${summary}`, options: [] }, taskController?.signal)) === 'yes',
          ask: (question: string, options?: string[]) => waitForUser({ kind: 'question', prompt: question, options: options ?? [] }, taskController?.signal),
          readSessionActivity: getSessionActivity,
          updateTodos: setTodos,
          tracker: taskTrackerRef.current,
          readLedger: readLedgerRef.current,
          beforeChange: async (absolutePath: string, workspaceRoot: string) => {
            const tracker = taskTrackerRef.current;
            if (!tracker) return;
            await tracker.prepareChange(absolutePath, workspaceRoot);
            setTodos(tracker.toTodos());
          },
          onStatus: message => setAiStatus(message),
        };

        // Per-send streaming state. Each request owns its assistant message and
        // accumulator so concurrent or sequential streams can never mix output.
        let streamAssistantId: number | null = null;
        let streamContent = '';
        const toolMessageIds = new Map<string, number>();

        const streamedAssistantMessage = (content: string) => {
          if (streamAssistantId === null) return;
          const id = streamAssistantId;
          setMessages(current => current.map(message => message.id === id
            ? { ...message, content, streaming: true }
            : message));
        };
        const beginAssistantMessage = () => {
          const id = ++messageIdRef.current;
          streamAssistantId = id;
          liveStreamMessageId = id;
          setMessages(current => [...current, { id, role: 'assistant', content: '', streaming: true }]);
        };

        const responseStartedAt = Date.now();
        const loopResult = await runAgentLoop({
          workspaceRoot: process.cwd(),
          objective: taskObjective,
          signal: taskController.signal,
          systemMessage: createSystemMessage(requestedMode, taskTools),
          initialMessages: [...priorConversation, modelUserMessage],
          readLedger: readLedgerRef.current,
          allowedToolNames: taskTools.map(tool => tool.function.name),
          maxTurns: readPositiveInteger(agentConfig.maxTurns),
          maxToolCalls: readPositiveInteger(agentConfig.maxToolCalls),
          deadlineMs: readPositiveNumber(agentConfig.deadlineMs),
          maxToolOutputChars: readPositiveInteger(agentConfig.maxToolOutputChars),
          maxHistoryMessages: readPositiveInteger(agentConfig.maxHistoryMessages),
          maxPromptTokens: promptBudget,
          keepRecentToolResults: readPositiveInteger(agentConfig.keepRecentToolResults),
          omitOldToolResultChars: readPositiveInteger(agentConfig.omitOldToolResultChars),
          pricing,
          chat: async (conversation, signal, turnOptions) => {
            const turnTools = turnOptions?.tools ?? taskTools;
            const streamCallbacks = {
              signal,
              onThinking: () => setAiStatus('Thinking'),
              onText: (chunk: string) => {
                if (streamAssistantId === null) beginAssistantMessage();
                streamContent += chunk;
                streamedAssistantMessage(streamContent);
              },
            } as const;
            if (activeProviderId === 'openai') {
              return await chatOpenAI(
                activeApiKey,
                activeModel.model,
                conversation,
                turnTools,
                streamCallbacks,
                generationOptions,
              );
            }
            if (activeProviderId === 'google') {
              return await chatGoogle(
                activeApiKey,
                activeModel.model,
                conversation,
                turnTools,
                streamCallbacks,
                generationOptions,
              );
            }
            if (activeProviderId === 'anthropic') {
              return await chatAnthropic(
                activeApiKey,
                activeModel.model,
                conversation,
                turnTools,
                streamCallbacks,
                generationOptions,
              );
            }
            if (activeProviderId === 'xai') {
              return await chatXai(
                activeApiKey,
                activeModel.model,
                conversation,
                turnTools,
                streamCallbacks,
                generationOptions,
              );
            }
            if (activeProviderId === 'dash') {
              return await chatDash(
                activeModel.model,
                conversation,
                turnTools,
                streamCallbacks,
                generationOptions,
                { deviceId: getDeviceId() },
              );
            }
            return await chatNvidia(
              activeApiKey,
              activeModel.model,
              conversation,
              turnTools,
              streamCallbacks,
              generationOptions,
            );
          },
          tools: taskTools,
          executeTool: async (name, args, context) => {
            const binding = mcpBindingByName.get(name);
            if (!binding) return executeAgentTool(name, args, context);
            const connection = mcpConnectionsRef.current.get(binding.serverName.toLowerCase());
            if (!connection) throw new Error(`MCP server ${binding.serverName} disconnected.`);
            const approved = await context.approve(
              name,
              `Call MCP tool ${binding.serverName}.${binding.remoteName}\nArguments: ${args.slice(0, 800)}`,
            );
            if (!approved) throw new Error('User denied the MCP tool call.');
            return callMcpTool(connection, binding, args);
          },
          toolContext,
          tracker: runTracker,
          callbacks: {
            onStatus: (phase, message) => {
              const label = PHASE_LABELS[phase] ?? message;
              setAiStatus(taskController?.signal.aborted ? 'Stopping task…' : label);
            },
            onThinking: () => setAiStatus(status => status === 'Thinking' ? status : 'Thinking'),
            onText: () => {},
            onTurnStart: (turn) => {},
            onToolCall: (call) => {
              setAiStatus(toolActivityLabel(call.name, call.args));
              let toolPath = '';
              try {
                const parsedArgs = JSON.parse(call.args || '{}') as Record<string, unknown>;
                  const firstBatchPath = Array.isArray(parsedArgs.files)
                    ? (parsedArgs.files[0] as Record<string, unknown> | undefined)?.path
                    : undefined;
                  toolPath = String(parsedArgs.path ?? firstBatchPath ?? parsedArgs.pattern ?? parsedArgs.query ?? parsedArgs.command ?? '');
              } catch { /* The tool executor reports malformed arguments. */ }
              streamContent = '';
              if (streamAssistantId !== null) {
                const finishedStreamId = streamAssistantId;
                setMessages(current => current.map(message => message.id === finishedStreamId
                  ? { ...message, streaming: false }
                  : message));
                liveStreamMessageId = null;
              }
              streamAssistantId = null;
              const toolMessageId = ++messageIdRef.current;
              setMessages(current => [...current, {
                id: toolMessageId,
                role: 'tool',
                toolName: call.name,
                toolPath,
                toolStatus: 'running',
              }]);
              toolMessageIds.set(call.id, toolMessageId);
            },
            onToolResult: (call, output, failed, timing) => {
              const id = toolMessageIds.get(call.id) ?? null;
              toolMessageIds.delete(call.id);
              if (id === null) return;
              const isMutation = call.name === 'write_file' || call.name === 'edit_file' || call.name === 'multi_edit' || call.name === 'multi_file_edit' || call.name === 'apply_patch';
              const display = failed
                ? structuredFailureMessage(output)
                : isMutation
                  ? fileMutationDisplay(output)
                  : (isDiffOutput(output) ? output : toolOutputPreview(output));
              // Determine tool success: a tool is considered successful when
              // it did not fail AND its output is not a structured failure.
              const isStructured = output.startsWith('{');
              const parsed = isStructured ? JSON.parse(output) : {};
              const toolSucceeded = !failed && (isStructured ? parsed.success !== false : true);
              setMessages(current => current.map(message => message.id === id
                ? { ...message, toolStatus: toolSucceeded ? 'success' : 'error', toolOutput: display, toolDurationMs: timing?.durationMs }
                : message));
            },
            onSystemNotice: notice => {
              void notice;
            },
            onRequestTelemetry: telemetry => {
              setContextTokens(telemetry.inputTokens + telemetry.outputTokens);
            },
            onContextCompacted: info => {
              setContextTokens(0);
              setMessages(current => [...current, {
                id: ++messageIdRef.current,
                role: 'assistant',
                content: `Context compacted: ${info.droppedMessages} earlier messages were summarized to fit the model window (${formatTokenCount(info.maxPromptTokens)} token prompt budget).`,
              }]);
            },
          },
        });

        const resultPhase = loopResult.phase;
  const responseDurationMs = Date.now() - responseStartedAt;
        setTodos(runTracker.toTodos());
        const systemForNextPrompt = conversationRef.current.find(message => message.role === 'system') ?? getSystemMessage();
        conversationRef.current = [
          systemForNextPrompt,
          ...loopResult.conversation.filter(message => message.role !== 'system'),
        ];
        const taskTokens = loopResult.telemetry.usageSource === 'provider'
          ? loopResult.tokenUsage.totalTokens
          : loopResult.telemetry.totalTokens;
        if (taskTokens > 0) {
          setTokens(t => t + taskTokens);
          if (loopResult.telemetry.usageSource !== 'provider') setTokensEstimated(true);
        }
        if (resultPhase === 'completed') {
          setAiStatus('');
        } else if (resultPhase === 'cancelled') {
          setAiStatus('Task stopped at your request. Progress is saved.');
        } else if (resultPhase === 'blocked') {
          setAiStatus(`Task paused: ${loopResult.interrupted ? 'deadline or step budget reached' : 'blocker or approval needed'}. Send a follow-up to continue.`);
        } else if (resultPhase === 'failed') {
          setAiStatus(`Task failed: ${loopResult.finalMessage.slice(0, 160)}`);
        }
        if (streamAssistantId === null && loopResult.finalMessage) {
          setMessages(current => [...current, {
            id: ++messageIdRef.current,
            role: 'assistant',
            content: loopResult.finalMessage,
            generationDurationMs: responseDurationMs,
          }]);
        } else if (streamAssistantId !== null) {
          const id = streamAssistantId;
          if (loopResult.finalMessage) streamContent = loopResult.finalMessage;
          if (resultPhase === 'cancelled' && streamContent) {
            streamContent = `${streamContent}\n\n[Stopped by user]`;
          }
          if (streamContent) {
            const content = streamContent;
            setMessages(current => current.map(message => message.id === id
              ? { ...message, content, streaming: false, generationDurationMs: responseDurationMs }
              : message));
          }
          setMessages(current => current.map(message => message.id === id
            ? { ...message, streaming: false, generationDurationMs: responseDurationMs }
            : message));
          liveStreamMessageId = null;
        }
        streamAssistantId = null;
        streamContent = '';

        // Verification results are information for the user. They are appended
        // after the agent's own answer and never trigger further agent work.
        const noteworthyChecks = loopResult.verification.filter(result =>
          result.status === 'fail' || result.status === 'blocked');
        if (noteworthyChecks.length > 0) {
          const summary = noteworthyChecks
            .slice(0, 4)
            .map(result => `${result.name}: ${result.preExisting === true ? 'pre-existing failure, unrelated to this change' : result.status}`)
            .join('; ');
          setMessages(current => [...current, {
            id: ++messageIdRef.current,
            role: 'assistant',
            content: `Info — project checks: ${summary}. This is informational only.`,
          }]);
        }
      } else if (!activeModel?.model) {
        setMessages(m => [...m, { role: 'assistant', content: 'Select a model first with /models.' }]);
      } else {
        setMessages(m => [...m, { role: 'assistant', content: 'Set API key first with /providers' }]);
      }
    } finally {
      if (liveStreamMessageId !== null) {
        const unfinishedStreamId = liveStreamMessageId;
        setMessages(current => current.map(message => message.id === unfinishedStreamId
          ? { ...message, streaming: false }
          : message));
      }
      if (taskTimeout) clearTimeout(taskTimeout);
      if (taskController && activeTaskRef.current === taskController) activeTaskRef.current = null;
      setTaskRunning(false);
      setStopArmed(false);
      setAiStatus('');
      sendingRef.current = false;
      // DASH only: refresh the device's daily ledger after the request.
      if (activeModel?.provider === 'dash') refreshDashQuota();
    }
  };

  const runCommand = (command: Command) => {
    void send(command.key);
  };

  const closeCommandPopup = () => {
    setInput('');
    setInputResetKey(value => value + 1);
    setCommandIndex(0);
  };

  const selectMention = (suggestion: { path: string; type: 'file' }) => {
    const composer = composerRef.current;
    const currentText = composer?.plainText ?? input;
    const mention = getActiveMention(currentText, composer?.cursorOffset ?? currentText.length);
    if (!mention) return;
    const updated = replaceMention(currentText, mention, suggestion);
    composer?.setText(updated.text);
    if (composer) composer.cursorOffset = updated.cursor;
    setInput(updated.text);
    setMentionCursor(0);
    recallIndexRef.current = -1;
    draftInputRef.current = updated.text;
  };

  const saveApiKey = () => {
    if (!apiKeyInput.trim()) return;
    const providerId = selectedProviderId ?? currentProvider;
    const key = apiKeyInput.trim();
    const providers = { ...config.providers };

    if (providerId === 'nvidia') {
      providers.nvidia = { apiKey: key, model: '' };
      setConfig({ ...config, providers });
      saveConfig({ ...config, providers });
      listNvidiaModels(key).then(ms => {
        setModels(ms);
        setProviderModels(prev => [...prev, { provider: 'NVIDIA', models: ms }]);
        setModelList(prev => [...prev, 'NVIDIA', ...ms]);
        setAwaitingApiKey(false);
        setApiKeyInput('');
        setSelectedProviderId(null);
        setCopyMessage('NVIDIA API key saved.');
      });
      return;
    }
    if (providerId === 'openai') {
      providers.openai = { apiKey: key, model: '' };
      setConfig({ ...config, providers });
      saveConfig({ ...config, providers });
      listOpenAIModels(key).then(ms => {
        setModels(ms);
        setProviderModels(prev => [...prev, { provider: 'OPENAI', models: ms }]);
        setModelList(prev => [...prev, 'OpenAI', ...ms]);
        setAwaitingApiKey(false);
        setApiKeyInput('');
        setSelectedProviderId(null);
        setCopyMessage('OpenAI API key saved.');
      });
      return;
    }
    if (providerId === 'google') {
      providers.google = { apiKey: key, model: '' };
      setConfig({ ...config, providers });
      saveConfig({ ...config, providers });
      listGoogleModels(key).then(ms => {
        setModels(ms);
        setProviderModels(prev => [...prev, { provider: 'GOOGLE', models: ms }]);
        setModelList(prev => [...prev, 'Google', ...ms]);
        setAwaitingApiKey(false);
        setApiKeyInput('');
        setSelectedProviderId(null);
        setCopyMessage('Google API key saved.');
      });
      return;
    }
    if (providerId === 'anthropic') {
      providers.anthropic = { apiKey: key, model: '' };
      setConfig({ ...config, providers });
      saveConfig({ ...config, providers });
      listAnthropicModels(key).then(ms => {
        setModels(ms);
        setProviderModels(prev => [...prev, { provider: 'ANTHROPIC', models: ms }]);
        setModelList(prev => [...prev, 'ANTHROPIC', ...ms]);
        setAwaitingApiKey(false);
        setApiKeyInput('');
        setSelectedProviderId(null);
        setCopyMessage('Anthropic API key saved.');
      });
      return;
    }
    if (providerId === 'xai') {
      providers.xai = { apiKey: key, model: '' };
      setConfig({ ...config, providers });
      saveConfig({ ...config, providers });
      listXaiModels(key).then(ms => {
        setModels(ms);
        setProviderModels(prev => [...prev, { provider: 'XAI', models: ms }]);
        setModelList(prev => [...prev, 'XAI', ...ms]);
        setAwaitingApiKey(false);
        setApiKeyInput('');
        setSelectedProviderId(null);
        setCopyMessage('xAI API key saved.');
      });
      return;
    }
  };

  const selectModel = (idx: number) => {
    const newModel = filteredModelList[idx];
    if (!newModel || isProviderHeaderRow(newModel)) {
      return;
    }
    // The visible provider section is authoritative: model IDs can overlap
    // between DASH and a user's separately configured NVIDIA account.
    const providerName = providerNameAtModelIndex(filteredModelList, idx);
    const providerId = providerName ? PROVIDER_IDS[providerName] : undefined;
    if (!providerId) {
      return;
    }
    const providers = { ...config.providers };
    const existingProvider = (providers as any)[providerId];
    (providers as any)[providerId] = {
      ...(existingProvider && typeof existingProvider === 'object' ? existingProvider : { apiKey: '' }),
      model: newModel,
    };
    const newCfg = { ...config, providers, activeModel: { provider: providerId, model: newModel } };
    setConfig(newCfg);
    saveConfig(newCfg);
    setActiveModel({ provider: providerId, model: newModel });
    setCurrentProvider(providerId);
    setModelIndex(idx);
    setModelsPopupOpen(false);
  };

  const selectProvider = (index: number) => {
    const selected = PROVIDERS[index];
    if (!selected) return;
    const providerId = selected.id as ProviderId;
    const existingKey = config.providers?.[providerId]?.apiKey ?? '';
    setSelectedProviderId(providerId);
    setProvidersPopupOpen(false);
    setCurrentProvider(providerId);
    setAwaitingApiKey(true);
    setApiKeyInput(existingKey);
  };

  const pasteFromClipboard = async (): Promise<void> => {
    const composer = composerRef.current;
    if (!composer && !awaitingApiKey) return;
    if (!hostClipboardRef.current) {
      try {
        hostClipboardRef.current = createHostClipboard();
      } catch {
        setCopyStatus('Paste is unavailable in this terminal');
        return;
      }
    }
    const service = hostClipboardRef.current;
    try {
      const result = await service.read({ preferredTypes: ['text/plain'], selection: 'clipboard' });
      if (result.status === 'read') {
        const text = new TextDecoder().decode(result.representation.bytes);
        if (text) {
          if (awaitingApiKey) setApiKeyInput(current => current + text);
          else composer?.insertText(text);
        }
      } else if (result.status === 'failed' || result.status === 'unsupported') {
        setCopyStatus('Paste is unavailable in this terminal');
      } else if (result.status === 'limit-exceeded') {
        setCopyStatus('Clipboard content is too large to paste');
      } else {
        setCopyStatus('Paste failed');
      }
    } catch {
      setCopyStatus('Paste failed');
    }
  };

  const installLatestUpdate = async (): Promise<void> => {
    setUpdateStatus('installing');
    setUpdateError('');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npm', ['install', '--global', '@neuro.corp/dash@latest'], {
          shell: process.platform === 'win32',
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', chunk => {
          stderr = `${stderr}${String(chunk)}`.slice(-1000);
        });
        child.once('error', reject);
        child.once('close', code => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `npm exited with code ${code ?? 'unknown'}`));
        });
      });
      setUpdateStatus('restart');
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Could not install the update');
      setUpdateStatus('error');
    }
  };

  const deleteTodoAt = (index: number) => {
    const remaining = todos.filter((_, todoIndex) => todoIndex !== index);
    setTodos(remaining.map((todo, todoIndex) => ({ ...todo, id: todoIndex + 1 })));
    taskTrackerRef.current?.removeStepAt(index);
    setTodoSelected(current => remaining.length === 0 ? 0 : Math.min(current, remaining.length - 1));
    setTodoScrollTop(top => Math.max(0, Math.min(top, Math.max(0, remaining.length - 12))));
  };

  useKeyboard((key) => {
    const composer = composerRef.current;
    const editIdle = !showCommands && !mcpPopupOpen && !todosPopupOpen && !sessionsPopupOpen && !modelsPopupOpen && !pendingRequest && !awaitingApiKey && !providersPopupOpen;

    if (mentionSuggestions.length > 0 && !showCommands && !mcpPopupOpen && !pendingRequest && !awaitingApiKey) {
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        setMentionCursor(index => key.name === 'up'
          ? (index - 1 + mentionSuggestions.length) % mentionSuggestions.length
          : (index + 1) % mentionSuggestions.length);
        return;
      }
      if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
        key.preventDefault();
        const selected = mentionSuggestions[safeMentionIndex];
        if (selected) selectMention(selected);
        return;
      }
    }

    if (key.ctrl && key.shift && key.name.toLowerCase() === 'c') {
      key.preventDefault();
      const inputText = composer?.plainText ?? '';
      const selectedText = inputText || (renderer.getSelection()?.getSelectedText() ?? '');
      if (!selectedText) {
        setCopyStatus('Select text first');
        return;
      }
      const label = inputText ? 'Input copied' : 'Selection copied';
      try {
        const copied = renderer.copyToClipboardOSC52(selectedText);
        setCopyStatus(copied ? label : 'Clipboard copy is unavailable in this terminal');
        // Show the top-right copy message asynchronously to avoid OpenTUI renderer issues
        setTimeout(() => {
          setCopyMessage(copied ? 'Text Copied!' : 'Copy failed');
        }, 0);
      } catch {
        setCopyStatus('Clipboard copy failed');
        setTimeout(() => {
          setCopyMessage('Copy failed');
        }, 0);
      }
      return;
    }

    if (updatesPopupOpen) {
      if (key.name === 'escape') {
        key.preventDefault();
        setUpdatesPopupOpen(false);
      } else if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
        if (updateStatus === 'available') {
          key.preventDefault();
          void installLatestUpdate();
        } else if (updateStatus === 'restart') {
          key.preventDefault();
          renderer.destroy();
        }
      }
      return;
    }

    if (awaitingApiKey && key.ctrl && !key.shift && key.name.toLowerCase() === 'v') {
      key.preventDefault();
      void pasteFromClipboard();
      return;
    }

    if (editIdle && composer) {
      const comboName = key.name.toLowerCase();
      if (key.ctrl && !key.shift && comboName === 'a') {
        key.preventDefault();
        composer.selectAll();
        return;
      }
      if (key.ctrl && !key.shift && comboName === 'x') {
        key.preventDefault();
        const selected = composer.getSelectedText();
        if (selected) {
          try {
            renderer.copyToClipboardOSC52(selected);
          } catch {
            // cutting without a working clipboard is still allowed
          }
          composer.deleteSelection();
        }
        return;
      }
      if (key.ctrl && !key.shift && comboName === 'v') {
        key.preventDefault();
        void pasteFromClipboard();
        return;
      }
      if (key.ctrl && !key.shift && comboName === 'z') {
        key.preventDefault();
        composer.undo();
        return;
      }
      if (key.ctrl && !key.shift && comboName === 'y') {
        key.preventDefault();
        composer.redo();
        return;
      }
      if ((key.name === 'up' || key.name === 'down') && !key.shift) {
        const recalling = recallIndexRef.current !== -1;
        const canRecall = composer.plainText === '' || recalling;
        if (!canRecall) return;
        if (key.name === 'down' && !recalling) return;
        const history = inputHistoryRef.current;
        if (history.length === 0) return;
        key.preventDefault();
        let index = recallIndexRef.current;
        if (key.name === 'down') {
          if (index === -1) return;
          index += 1;
          if (index >= history.length) {
            const draft = draftInputRef.current;
            recallIndexRef.current = -1;
            recallingRef.current = true;
            composer.setText(draft);
            setInput(draft);
            composer.cursorOffset = draft.length;
            return;
          }
        } else {
          if (index === -1) {
            draftInputRef.current = composer.plainText;
            index = history.length - 1;
          } else {
            index = Math.max(0, index - 1);
          }
        }
        const entry = history[index] ?? '';
        recallIndexRef.current = index;
        recallingRef.current = true;
        composer.setText(entry);
        setInput(entry);
        composer.cursorOffset = entry.length;
        return;
      }
    }

    if (key.ctrl && key.name.toLowerCase() === 't' && todos.length > 0) {
      key.preventDefault();
      setTodosPopupOpen(open => !open);
      setTodoScrollTop(0);
      setTodoSelected(0);
      return;
    }
    if (key.name === 'escape') {
      if (mcpPopupOpen) {
        key.preventDefault();
        if (mcpGuideOpen) setMcpGuideOpen(false);
        else setMcpPopupOpen(false);
        return;
      }
      if (providersPopupOpen) {
        key.preventDefault();
        setProvidersPopupOpen(false);
        return;
      }
      if (modelsPopupOpen) {
        key.preventDefault();
        setModelsPopupOpen(false);
        return;
      }
      if (sessionsPopupOpen) {
        key.preventDefault();
        setSessionsPopupOpen(false);
        return;
      }
      if (todosPopupOpen) {
        key.preventDefault();
        setTodosPopupOpen(false);
        return;
      }
      if (showCommands) {
        key.preventDefault();
        setInput('');
        setInputResetKey(value => value + 1);
        setCommandIndex(0);
        return;
      }
      if (pendingRequest) {
        key.preventDefault();
        resolveUserRequest(pendingRequest.kind === 'approval' ? 'no' : 'cancelled');
        return;
      }
      if (activeTaskRef.current) {
        if (taskRunning && !stopArmed) {
          key.preventDefault();
          setStopArmed(true);
          setAiStatus('Press Esc again to stop the task');
          return;
        }
        activeTaskRef.current.abort('Stopped by user');
        setStopArmed(false);
        setAiStatus('Stopping task…');
      }
      setAwaitingApiKey(false);
      setModelsPopupOpen(false);
      setSessionsPopupOpen(false);
      setTodosPopupOpen(false);
      setInput('');
      setInputHeight(MIN_INPUT_HEIGHT);
      setInputResetKey(value => value + 1);
      key.preventDefault();
      return;
    }
    if (showCommands) {
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        setCommandIndex(index => {
          const len = filteredCommands.length || 1;
          return key.name === 'up'
            ? (index - 1 + len) % len
            : (index + 1) % len;
        });
        return;
      }
      if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
        key.preventDefault();
        const selectedCommand = filteredCommands[safeCommandIndex];
        if (selectedCommand) runCommand(selectedCommand);
        return;
      }
    }
    if (mcpPopupOpen) {
      if (mcpGuideOpen) {
        if (key.name === 'return' || key.name.toLowerCase() === 'g') {
          key.preventDefault();
          setMcpGuideOpen(false);
        }
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        if (mcpServerRows.length > 0) {
          setMcpCursor(index => key.name === 'up'
            ? (index - 1 + mcpServerRows.length) % mcpServerRows.length
            : (index + 1) % mcpServerRows.length);
        }
      } else if (key.name === 'return') {
        key.preventDefault();
        const selected = mcpServerRows[safeMcpCursor];
        if (selected) void toggleMcpServer(selected.config);
      } else if (key.ctrl && key.name.toLowerCase() === 'd') {
        key.preventDefault();
        const selected = mcpServerRows[safeMcpCursor];
        if (selected) void removeMcpServer(selected.config);
      } else if (key.name.toLowerCase() === 'g') {
        key.preventDefault();
        setMcpGuideOpen(true);
      }
      return;
    }
    if (todosPopupOpen) {
      const maxTop = Math.max(0, todos.length - 12);
      const selected = Math.max(0, Math.min(todoSelected, todos.length - 1));
      if (key.name === 'up') {
        key.preventDefault();
        const next = (selected - 1 + todos.length) % todos.length;
        setTodoSelected(next);
        setTodoScrollTop(top => {
          if (next < top) return next;
          if (next >= top + 12) return Math.min(maxTop, next - 11);
          return top;
        });
      } else if (key.name === 'down') {
        key.preventDefault();
        const next = (selected + 1) % todos.length;
        setTodoSelected(next);
        setTodoScrollTop(top => {
          if (next < top) return next;
          if (next >= top + 12) return Math.min(maxTop, next - 11);
          return top;
        });
      } else if (key.name === 'return') {
        key.preventDefault();
        setTodosPopupOpen(false);
      } else if (key.ctrl && key.name.toLowerCase() === 'd') {
        key.preventDefault();
        deleteTodoAt(selected);
      }
      return;
    }
    if (sessionsPopupOpen) {
      if (sessionPopupSessions.length === 0) return;
      if (key.name === 'up') {
        key.preventDefault();
        setSessionIndex(index => (index - 1 + sessionPopupSessions.length) % sessionPopupSessions.length);
      } else if (key.name === 'down') {
        key.preventDefault();
        setSessionIndex(index => (index + 1) % sessionPopupSessions.length);
      } else if (key.name === 'return') {
        key.preventDefault();
        const sel = sessionPopupSessions[sessionIndex];
        if (sel) selectSession(sel.id);
      } else if (key.ctrl && key.name === 'd') {
        key.preventDefault();
        deleteSelectedSession();
      }
      return;
    }
    if (providersPopupOpen) {
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        setProviderCursor(cursor =>
          key.name === 'up'
            ? (cursor - 1 + PROVIDERS.length) % PROVIDERS.length
            : (cursor + 1) % PROVIDERS.length
        );
        return;
      }
      if (key.name === 'return') {
        key.preventDefault();
        selectProvider(providerCursor);
        return;
      }
      return;
    }
    if (modelsPopupOpen) {
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        const len = filteredModelList.length;
        if (len > 0) {
          let next = modelCursor;
          do {
            next = key.name === 'up'
              ? (next - 1 + len) % len
              : (next + 1) % len;
          } while (next !== modelCursor && isProviderHeaderRow(filteredModelList[next] ?? ''));
          setModelCursor(next);
          setModelScrollTop(top => {
            if (next < top) return next;
            if (next >= top + MODELS_VISIBLE_ROWS) return next - MODELS_VISIBLE_ROWS + 1;
            return top;
          });
        }
      } else if (key.name === 'return') {
        key.preventDefault();
        selectModel(modelCursor);
      }
      return;
    }
    if (pendingRequest) {
      const keyName = key.name.toLowerCase();
      if (keyName === 'escape') {
        resolveUserRequest(pendingRequest.kind === 'approval' ? 'no' : 'cancelled');
      } else if (pendingRequest.kind === 'approval') {
        if (keyName === 'up' || keyName === 'down' || keyName === 'left' || keyName === 'right') {
          key.preventDefault();
          setRequestChoiceIndex(i => (i === 0 ? 1 : 0));
        }
        if (keyName === 'return') {
          key.preventDefault();
          resolveUserRequest(requestChoiceIndex === 0 ? 'yes' : 'no');
        }
      } else if (pendingRequest.kind === 'question' && pendingRequest.options.length > 0) {
        if (keyName === 'up') {
          key.preventDefault();
          setRequestChoiceIndex(i => (i - 1 + pendingRequest.options.length) % pendingRequest.options.length);
        }
        if (keyName === 'down') {
          key.preventDefault();
          setRequestChoiceIndex(i => (i + 1) % pendingRequest.options.length);
        }
        if (keyName === 'return') {
          key.preventDefault();
          resolveUserRequest(pendingRequest.options[requestChoiceIndex] ?? 'No option selected');
        }
      }
      return;
    }
    if (key.ctrl && key.name === 'c') return;
  });

  const modelName = isDashModel
    ? dashModelsEntry?.displayNames?.[currentModel] ?? currentModel
    : currentModel;
  const popupWidth = Math.max(1, Math.min(64, terminalWidth - 2));
  const popupHeight = Math.max(1, Math.min(18, terminalHeight - 2));
  const modelsPopupHeight = Math.max(1, Math.min(24, terminalHeight - 2));
  const updatesPopupHeight = Math.max(1, Math.min(10, terminalHeight - 2));

  return (
    <box flexDirection="column" width={terminalWidth} height={terminalHeight} style={{ backgroundColor: colors.lowBlack }}>
      <CopyMessage text={copyMessage} onComplete={() => setCopyMessage(null)} />
      {/* <Header /> */}
      <box flexGrow={1}>
        <MessageList messages={messages} terminalWidth={terminalWidth} terminalHeight={terminalHeight} isThinking={taskRunning} thinkingText={aiStatus || 'Thinking'} />
      </box>
      {todos.length > 0 && (
        <TodoBar
          todos={todos}
          terminalWidth={terminalWidth}
          onOpen={() => { setTodosPopupOpen(true); setTodoScrollTop(0); setTodoSelected(0); }}
        />
      )}
      {showCommands && filteredCommands.length > 0 && (
        <CommandPopup
          commands={filteredCommands}
          selectedIndex={safeCommandIndex}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
          onSelectIndex={setCommandIndex}
          onRun={runCommand}
          onClose={closeCommandPopup}
        />
      )}
      {!showCommands && mentionSuggestions.length > 0 && activeMention && (
        <MentionMenu
          suggestions={mentionSuggestions}
          selectedIndex={safeMentionIndex}
          width={resolveMentionPopupWidth(mentionSuggestions, terminalWidth)}
          terminalHeight={terminalHeight}
          onSelectIndex={setMentionCursor}
          onSelect={selectMention}
        />
      )}
      {mcpPopupOpen && (
        <McpPopup
          popupWidth={terminalWidth}
          popupHeight={terminalHeight}
          servers={mcpServerRows}
          cursorIndex={safeMcpCursor}
          guideOpen={mcpGuideOpen}
          busyServer={mcpBusyServer}
          onSelectIndex={setMcpCursor}
          onToggleServer={server => { void toggleMcpServer(server); }}
          onDisableServer={server => { void disableMcpServer(server); }}
          onRemoveServer={server => { void removeMcpServer(server); }}
          onGuide={() => setMcpGuideOpen(true)}
          onBack={() => setMcpGuideOpen(false)}
          onClose={() => setMcpPopupOpen(false)}
        />
      )}
      {providersPopupOpen && (
        <ProvidersPopup
          popupWidth={popupWidth}
          popupHeight={popupHeight}
          providers={PROVIDERS}
          cursorIndex={providerCursor}
          onSelectIndex={setProviderCursor}
          onSelect={selectProvider}
          onClose={() => setProvidersPopupOpen(false)}
        />
      )}
      {awaitingApiKey && (
        <ApiKeyPopup
          popupWidth={popupWidth}
          popupHeight={popupHeight}
          apiKeyInput={apiKeyInput}
          setApiKeyInput={setApiKeyInput}
          saveApiKey={saveApiKey}
          providerName={selectedProviderId ? PROVIDERS.find(p => p.id === selectedProviderId)?.name ?? currentProvider : currentProvider.toUpperCase()}
          onClose={() => setAwaitingApiKey(false)}
        />
      )}
      {modelsPopupOpen && (
        <ModelsPopup
          popupWidth={popupWidth}
          popupHeight={modelsPopupHeight}
          groups={visibleModelGroups}
          cursorIndex={modelCursor}
          scrollTop={modelScrollTop}
          currentModel={currentModel}
          currentProvider={activeModel?.provider ?? ''}
          search={modelsSearch}
          onSearchChange={setModelsSearch}
          displayNames={dashDisplayNames}
          loading={modelsLoading}
          error={modelsError}
          onSubmit={() => selectModel(modelCursor)}
          onSelectIndex={setModelCursor}
          onSelect={selectModel}
          onScroll={delta => setModelScrollTop(top => Math.max(0, Math.min(top + delta, Math.max(0, filteredModelList.length - MODELS_VISIBLE_ROWS))))}
          onClose={() => setModelsPopupOpen(false)}
        />
      )}
      {updatesPopupOpen && (
        <UpdatesPopup
          popupWidth={popupWidth}
          popupHeight={updatesPopupHeight}
          status={updateStatus}
          installedVersion={updateInfo?.installed}
          latestVersion={updateInfo?.latest}
          error={updateError}
          onUpdate={() => { void installLatestUpdate(); }}
          onRestart={() => renderer.destroy()}
          onClose={() => setUpdatesPopupOpen(false)}
        />
      )}
      {sessionsPopupOpen && (
        <SessionsPopup
          popupWidth={popupWidth}
          popupHeight={popupHeight}
          sessions={sessionPopupSessions}
          sessionIndex={sessionIndex}
          currentSessionId={activeSessionId}
          onSelectIndex={setSessionIndex}
          onSelect={selectSession}
          onDelete={deleteSelectedSession}
          onClose={() => setSessionsPopupOpen(false)}
        />
      )}
      {todosPopupOpen && todos.length > 0 && (
        <TodosPopup
          popupWidth={popupWidth}
          popupHeight={popupHeight}
          todos={todos}
          scrollTop={todoScrollTop}
          selectedIndex={todoSelected}
          onHover={index => setTodoSelected(index)}
          onSelect={index => {
            setTodoSelected(index);
            setTodoScrollTop(top => index < top ? index : index >= top + 12 ? index - 11 : top);
          }}
          onDelete={deleteTodoAt}
          onScroll={delta => setTodoScrollTop(top => Math.max(0, Math.min(top + delta, Math.max(0, todos.length - 12))))}
          onClose={() => setTodosPopupOpen(false)}
        />
      )}
      {pendingRequest && (
        <PendingRequestPopup
          popupWidth={popupWidth}
          popupHeight={popupHeight}
          pendingRequest={pendingRequest}
          requestChoiceIndex={requestChoiceIndex}
          setRequestChoiceIndex={setRequestChoiceIndex}
          resolveUserRequest={resolveUserRequest}
          onClose={() => resolveUserRequest(pendingRequest.kind === 'approval' ? 'no' : 'cancelled')}
        />
      )}
      <box height={safeInputHeight + 3} style={{ backgroundColor: '#181818' }} paddingX={1} paddingTop={1} paddingBottom={1} marginX={2}>
        <textarea
          key={inputResetKey}
          ref={composerRef}
          width={composerWidth}
          height={safeInputHeight}
          wrapMode="word"
          placeholder="Ask dash to code something…"
          initialValue=""
          onContentChange={() => {
            const textarea = composerRef.current;
            const next = textarea?.plainText ?? '';
            setInput(next);
            if (recallingRef.current) {
              recallingRef.current = false;
            } else {
              recallIndexRef.current = -1;
              draftInputRef.current = next;
            }
            // Auto-resize: grow/shrink with content, scroll when at max height.
            if (textarea) {
              const lineCount = textarea.virtualLineCount ?? textarea.lineCount ?? 1;
              const isOverflow = lineCount > MAX_INPUT_HEIGHT;
              const targetHeight = isOverflow ? MAX_INPUT_HEIGHT : Math.max(MIN_INPUT_HEIGHT, lineCount);

              // When transitioning to/from overflow, adjust scroll to keep cursor in view.
              if (textarea) {
                const cursorOffset = textarea.cursorOffset ?? 0;
                const plainText = textarea.plainText ?? '';
                // Determine the cursor's logical row (1-indexed) within the plain text.
                const cursorRow = plainText.slice(0, cursorOffset).split('\n').length;
                const cursorCol = plainText.slice(0, cursorOffset).split('\n').pop()?.length ?? 0;

                if (isOverflow) {
                  // At max height: ensure cursor row is within visible area.
                  // scrollY is terminal rows; clamp so cursorRow-(MAX_INPUT_HEIGHT-3) stays >= 0.
                  const desiredScroll = Math.max(0, cursorRow - (MAX_INPUT_HEIGHT - 3));
                  // Attempt to scroll; if scrollTo is not available, fall back to direct assignment.
                  if (typeof textarea.scrollTo === 'function') {
                    textarea.scrollTo({ scrollY: desiredScroll });
                  } else {
                    // Direct assignment may work depending on runtime implementation.
                    try { (textarea as any).scrollY = desiredScroll; } catch { /* noop */ }
                  }
                } else {
                  // Below max: snap height to content.
                  if (targetHeight !== inputHeight) {
                    setInputHeight(targetHeight);
                    // Adjust scrollY so the cursor stays at the same relative position.
                    const maxScroll = Math.max(0, lineCount - MAX_INPUT_HEIGHT);
                    const desiredScroll = Math.min(cursorRow - 1, Math.max(0, maxScroll));
                    if (typeof textarea.scrollTo === 'function') {
                      textarea.scrollTo({ scrollY: desiredScroll });
                    } else {
                      try { (textarea as any).scrollY = desiredScroll; } catch { /* noop */ }
                    }
                  }
                }
              }

              // Apply the final height target.
              if (isOverflow) {
                // When overflowing, keep height at MAX_INPUT_HEIGHT; internal scrolling handles the rest.
                if (inputHeight !== MAX_INPUT_HEIGHT) {
                  setInputHeight(MAX_INPUT_HEIGHT);
                }
              } else if (targetHeight < inputHeight) {
                // Content shrank (e.g., deletions); shrink the input box.
                setInputHeight(targetHeight);
              } else if (targetHeight > inputHeight && !isOverflow) {
                // Content grew but still below max; expand.
                setInputHeight(targetHeight);
              }
            }
          }}
          keyBindings={[
            { name: 'return', action: 'submit' },
            { name: 'return', shift: true, action: 'newline' },
            { name: 'return', ctrl: true, action: 'submit' },
          ]}
          onSubmit={() => void send(composerRef.current?.plainText ?? input)}
          focused={!pendingRequest && !awaitingApiKey && !modelsPopupOpen && !sessionsPopupOpen && !todosPopupOpen && !updatesPopupOpen}
        />
        <box height={1} flexDirection="row" style={{ marginTop: 0, marginBottom: 1, marginLeft: 1 }}>
          <text>
            <span fg="#FAA937">Build</span>
            <span fg="gray" dim>{` • `}</span>
            <span fg="gray">{modelName}</span>
          </text>
          <box flexGrow={1} />
        </box>
      </box>
      <Footer
        tokenCount={tokens}
        tokenCountEstimated={tokensEstimated}
        quota={isDashModel ? dashQuota : null}
        contextTokens={contextTokens}
        contextWindow={activeCapacity.contextWindow}
        contextReserve={activeCapacity.maxOutputTokens}
        taskRunning={taskRunning}
        stopPending={taskRunning && stopArmed}
      />
    </box>
  );
}

