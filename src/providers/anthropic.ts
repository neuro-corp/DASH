import {
  ensureUniqueToolCallIds,
  type GenerationOptions,
  type NvidiaChatMessage,
  type NvidiaChatResult,
  type NvidiaStreamCallbacks,
  type NvidiaToolCall,
  type NvidiaUsage,
} from "./nvidia";

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MAX_TOKENS = 16_384;

export async function listAnthropicModels(apiKey: string) {
  if (!apiKey) return [];
  const ids: string[] = [];
  try {
    let afterId: string | undefined;
    do {
      const url = new URL(`${ANTHROPIC_API_BASE}/models`);
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);
      const res = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
      });
      if (!res.ok) return [];
      const data = await res.json() as {
        data?: Array<{ id?: string }>;
        has_more?: boolean;
        last_id?: string;
      };
      for (const model of data.data ?? []) {
        if (typeof model.id === 'string' && model.id.length > 0) ids.push(model.id);
      }
      afterId = data.has_more && data.last_id ? data.last_id : undefined;
    } while (afterId);
    return ids;
  } catch {
    return [];
  }
}

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed arguments are surfaced to the model as an empty object.
  }
  return {};
}

function toAnthropicMessages(messages: NvidiaChatMessage[]) {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];

  const append = (role: AnthropicMessage['role'], blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = converted.at(-1);
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      converted.push({ role, content: blocks });
    }
  };

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        });
      }
      append('assistant', blocks);
      continue;
    }
    if (message.role === 'tool') {
      append('user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: message.content ?? '',
      }]);
      continue;
    }
    append('user', [{ type: 'text', text: message.content ?? '' }]);
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: converted,
  };
}

function toAnthropicTools(tools: readonly unknown[]) {
  const converted: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }> = [];
  for (const tool of tools) {
    const fn = (tool as {
      function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
    }).function;
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) continue;
    converted.push({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return converted;
}

type AnthropicStreamUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicStreamUsage };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  usage?: AnthropicStreamUsage;
  error?: { type?: string; message?: string };
};

export async function chatAnthropic(
  apiKey: string,
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks = {},
  generation: GenerationOptions = {},
): Promise<NvidiaChatResult> {
  try {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);
    const body: Record<string, unknown> = {
      model,
      max_tokens: generation.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
      stream: true,
      ...(system ? { system } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(generation.temperature !== undefined ? { temperature: generation.temperature } : {}),
      ...(generation.topP !== undefined ? { top_p: generation.topP } : {}),
    };

    const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: callbacks.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      let detail = txt;
      try {
        const parsed = JSON.parse(txt) as { error?: { message?: string } };
        detail = parsed.error?.message ?? txt;
      } catch {
        // Keep the raw response body when it is not JSON.
      }
      return { content: `API error ${res.status}: ${detail}`, toolCalls: [] };
    }
    if (!res.body) return { content: 'Error: Anthropic returned an empty response stream', toolCalls: [] };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let errorMessage = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedPromptTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let usage: NvidiaUsage | undefined;
    const toolCalls = new Map<number, NvidiaToolCall>();

    const updateUsage = (raw: AnthropicStreamUsage | undefined) => {
      if (!raw) return;
      if (typeof raw.input_tokens === 'number') promptTokens = raw.input_tokens;
      if (typeof raw.output_tokens === 'number') completionTokens = raw.output_tokens;
      if (typeof raw.cache_read_input_tokens === 'number') cachedPromptTokens = raw.cache_read_input_tokens;
      if (typeof raw.cache_creation_input_tokens === 'number') cacheWriteTokens = raw.cache_creation_input_tokens;
      const totalPrompt = promptTokens + (cachedPromptTokens ?? 0) + (cacheWriteTokens ?? 0);
      const totalTokens = totalPrompt + completionTokens;
      if (totalTokens > 0) {
        usage = {
          promptTokens: totalPrompt,
          completionTokens,
          totalTokens,
          ...(cachedPromptTokens ? { cachedPromptTokens } : {}),
          ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
        };
      }
    };

    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const event = JSON.parse(payload) as AnthropicStreamEvent;
        if (event.type === 'error') {
          errorMessage = event.error?.message ?? 'Anthropic returned an error';
          return;
        }
        if (event.type === 'message_start') {
          updateUsage(event.message?.usage);
          return;
        }
        if (event.type === 'message_delta') {
          updateUsage(event.usage);
          return;
        }
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (!block) return;
          if (block.type === 'thinking') callbacks.onThinking?.();
          if (block.type === 'tool_use') {
            toolCalls.set(event.index ?? toolCalls.size, {
              id: block.id ?? '',
              type: 'function',
              function: { name: block.name ?? '', arguments: '' },
            });
          } else if (block.type === 'text' && block.text) {
            reply += block.text;
            callbacks.onText?.(block.text);
          }
          return;
        }
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (!delta) return;
          if (delta.type === 'text_delta' && delta.text) {
            reply += delta.text;
            callbacks.onText?.(delta.text);
          } else if (delta.type === 'thinking_delta') {
            callbacks.onThinking?.();
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const call = toolCalls.get(event.index ?? 0);
            if (call) call.function.arguments += delta.partial_json;
          }
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
      if (!reply && !errorMessage) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `Error: ${message}`, toolCalls: [] };
      }
      // Streaming dropped mid-response; keep whatever partial content we already have.
    }

    if (errorMessage && !reply) {
      return { content: `API error: ${errorMessage}`, toolCalls: [] };
    }

    const finalized = [...toolCalls.values()].map(call => ({
      ...call,
      function: {
        ...call.function,
        arguments: call.function.arguments || '{}',
      },
    }));
    return {
      content: reply,
      toolCalls: ensureUniqueToolCallIds(finalized),
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Error: ${message}`, toolCalls: [] };
  }
}
