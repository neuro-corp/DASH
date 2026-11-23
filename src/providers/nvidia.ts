const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
let toolCallFallbackSequence = 0;

export function ensureUniqueToolCallIds(toolCalls: NvidiaToolCall[]): NvidiaToolCall[] {
  const seen = new Set<string>();
  return toolCalls.map(call => {
    let id = call.id.trim();
    if (!id || seen.has(id)) id = `call_${(++toolCallFallbackSequence).toString(36)}`;
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}

/**
 * Providers stream ids/names either once, in partial fragments, or repeated on
 * every chunk. Appending blindly duplicates a repeated value; replacing blindly
 * drops a partial fragment. This handles all three shapes.
 */
export function appendStreamFragment(current: string, fragment: string | undefined): string {
  if (!fragment) return current;
  if (!current) return fragment;
  if (fragment === current || fragment.startsWith(current)) return fragment;
  if (current.startsWith(fragment) || current.endsWith(fragment)) return current;
  return current + fragment;
}

export async function listNvidiaModels(apiKey: string) {
  if (!apiKey) return [];
  try {
    const res = await fetch(`${NVIDIA_API_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      return [];
    }
    const data = await res.json() as { data?: any[]; models?: any[] } | any[];
    const entries = Array.isArray(data) ? data : data.data ?? data.models ?? [];
    const ids = entries
      .map((model: any) => typeof model === 'string' ? model : model.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
    return ids;
  } catch {
    return [];
  }
}

export interface NvidiaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface NvidiaChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: NvidiaToolCall[];
  tool_call_id?: string;
}

export interface NvidiaUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_tokens?: number;
  prompt_cache_hit_tokens?: number;
  reasoning_tokens?: number;
};

function optionalCount(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) return count;
  }
  return undefined;
}

export function normalizeUsage(raw: RawUsage | undefined): NvidiaUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = Number(raw.prompt_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? 0);
  const reportedTotal = Number(raw.total_tokens ?? 0);
  const totalTokens = reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
  const cachedPromptTokens = optionalCount(
    raw.prompt_tokens_details?.cached_tokens,
    raw.cached_tokens,
    raw.cache_read_input_tokens,
    raw.prompt_cache_hit_tokens,
  );
  const cacheWriteTokens = optionalCount(
    raw.prompt_tokens_details?.cache_creation_tokens,
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.cache_creation_input_tokens,
    raw.cache_write_tokens,
  );
  const reasoningTokens = optionalCount(
    raw.completion_tokens_details?.reasoning_tokens,
    raw.reasoning_tokens,
  );
  return {
    promptTokens: promptTokens || Math.max(0, totalTokens - completionTokens),
    completionTokens: completionTokens || Math.max(0, totalTokens - promptTokens),
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export interface NvidiaChatResult {
  content: string;
  toolCalls: NvidiaToolCall[];
  usage?: NvidiaUsage;
}

export interface NvidiaStreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: () => void;
  signal?: AbortSignal;
}

export async function chatNvidia(
  apiKey: string,
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks = {},
  generation: GenerationOptions = {},
): Promise<NvidiaChatResult> {
  return chatOpenAICompatible({
    baseUrl: NVIDIA_API_BASE,
    apiKey,
    model,
    messages,
    tools,
    callbacks,
    thinkingTemplate: true,
    generation,
  });
}

export interface GenerationOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export type OpenAICompatibleChatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: NvidiaChatMessage[];
  tools: readonly unknown[];
  callbacks?: NvidiaStreamCallbacks;
  thinkingTemplate?: boolean;
  generation?: GenerationOptions;
};

export async function chatOpenAICompatible(options: OpenAICompatibleChatOptions): Promise<NvidiaChatResult> {
  const { baseUrl, apiKey, model, messages, tools, callbacks = {}, thinkingTemplate, generation } = options;
  try {
    return await requestChat(baseUrl, apiKey, model, messages, tools, callbacks, thinkingTemplate, generation);
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Error: ${message}`, toolCalls: [] };
  }
}

async function requestChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks,
  thinkingTemplate?: boolean,
  generation: GenerationOptions = {},
): Promise<NvidiaChatResult> {
  const buildBody = (includeUsage: boolean): string => JSON.stringify({
    model,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    temperature: generation.temperature ?? 1,
    top_p: generation.topP ?? 0.95,
    max_tokens: generation.maxOutputTokens ?? 16384,
    ...(generation.reasoningEffort ? { reasoning_effort: generation.reasoningEffort } : {}),
    ...(thinkingTemplate ? { chat_template_kwargs: { enable_thinking: true } } : {}),
    stream: true,
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
  });

  let res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: buildBody(true),
    signal: callbacks.signal,
  });
  // Some models reject stream_options; retry once without it before surfacing the error.
  if (!res.ok) {
    const retryText = await res.clone().text().catch(() => '');
    if (/stream_options/i.test(retryText)) {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: buildBody(false),
        signal: callbacks.signal,
      });
    }
  }
  return streamChatResponse(res, callbacks);
}

async function streamChatResponse(res: Response, callbacks: NvidiaStreamCallbacks): Promise<NvidiaChatResult> {
  if (!res.ok) {
    const txt = await res.text();
    let msg = `API error ${res.status}: ${txt}`;
    if (res.status === 404 && txt.includes('Not found')) {
      msg = `API error 404: Model or function not found for this account. Please select a different model from the model list.`;
    }
    return { content: msg, toolCalls: [] };
  }
  if (!res.body) return { content: 'Error: the server returned an empty response stream', toolCalls: [] };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let usage: NvidiaUsage | undefined;
  const toolCalls = new Map<number, NvidiaToolCall>();

  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const chunk = JSON.parse(payload) as {
        usage?: RawUsage;
        choices?: Array<{ delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: 'function';
            function?: { name?: string; arguments?: string };
          }>;
        } }>;
      };
      if (chunk.usage) {
        usage = normalizeUsage(chunk.usage) ?? usage;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) callbacks.onThinking?.();
      if (delta?.content) {
        reply += delta.content;
        callbacks.onText?.(delta.content);
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const current = toolCalls.get(fragment.index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        current.id = appendStreamFragment(current.id, fragment.id);
        current.function.name = appendStreamFragment(current.function.name, fragment.function?.name);
        current.function.arguments += fragment.function?.arguments ?? '';
        toolCalls.set(fragment.index, current);
      }
    } catch {
      // Ignore malformed or non-JSON SSE data frames.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    if (!reply) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: ${message}`, toolCalls: [] };
    }
    // Streaming dropped mid-response; keep whatever partial content we already have.
  }

  return { content: reply, toolCalls: ensureUniqueToolCallIds([...toolCalls.values()]), usage };
}
