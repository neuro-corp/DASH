import type {
  GenerationOptions,
  NvidiaChatMessage,
  NvidiaChatResult,
  NvidiaStreamCallbacks,
  NvidiaToolCall,
} from "./nvidia";

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
let googleToolCallSequence = 0;

export async function listGoogleModels(apiKey: string) {
  if (!apiKey) return [];
  try {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${GOOGLE_API_BASE}/models`);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, {
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        return [];
      }
      const data = await res.json() as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
        nextPageToken?: string;
      };
      const entries = data.models ?? [];
      for (const model of entries) {
        if (typeof model.name !== 'string' || model.name.length === 0) continue;
        if (model.supportedGenerationMethods && !model.supportedGenerationMethods.includes('generateContent')) continue;
        ids.push(model.name.replace(/^models\//, ''));
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return ids;
  } catch {
    return [];
  }
}

type GooglePart = {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: Record<string, unknown> };
};

type GoogleContent = { role: string; parts: GooglePart[] };

type GoogleChunk = {
  candidates?: Array<{ content?: { parts?: GooglePart[] } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
};

const GOOGLE_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  '$schema',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'patternProperties',
  'title',
]);

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeSchema(item));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (GOOGLE_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = sanitizeSchema(child);
    }
    return out;
  }
  return value;
}

function toFunctionDeclarations(tools: readonly unknown[]) {
  const declarations: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = [];
  for (const tool of tools) {
    const fn = (tool as { type?: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }).function;
    if (!fn || typeof fn.name !== 'string') continue;
    declarations.push({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters ? sanitizeSchema(fn.parameters) as Record<string, unknown> : undefined,
    });
  }
  return declarations;
}

function toGoogleContents(messages: NvidiaChatMessage[]) {
  const contents: GoogleContent[] = [];
  let systemInstruction: { parts: GooglePart[] } | undefined;
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'system') {
      systemInstruction = { parts: [{ text: message.content ?? '' }] };
      continue;
    }
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: message.content ?? '' }] });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GooglePart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        toolNames.set(call.id, call.function.name);
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    if (message.role === 'tool') {
      const name = toolNames.get(message.tool_call_id ?? '') ?? 'tool';
      let value: unknown = message.content ?? '';
      try {
        value = JSON.parse(message.content ?? '');
      } catch {}
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: { result: value } } }] });
    }
  }
  return { contents, systemInstruction };
}

export async function chatGoogle(
  apiKey: string,
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks = {},
  generation: GenerationOptions = {},
): Promise<NvidiaChatResult> {
  try {
    const { contents, systemInstruction } = toGoogleContents(messages);
    const functionDeclarations = toFunctionDeclarations(tools);
    const generationConfig: Record<string, unknown> = {};
    if (generation.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = generation.maxOutputTokens;
    if (generation.temperature !== undefined) generationConfig.temperature = generation.temperature;
    if (generation.topP !== undefined) generationConfig.topP = generation.topP;
    const body: Record<string, unknown> = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };
    const res = await fetch(`${GOOGLE_API_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: callbacks.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      return { content: `API error ${res.status}: ${txt}`, toolCalls: [] };
    }
    if (!res.body) return { content: 'Error: Google returned an empty response stream', toolCalls: [] };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let usage: NvidiaChatResult['usage'];
    const toolCalls: NvidiaToolCall[] = [];

    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const chunk = JSON.parse(payload) as GoogleChunk;
        const usageMeta = chunk.usageMetadata;
        if (usageMeta) {
          const promptTokens = Number(usageMeta.promptTokenCount ?? 0);
          const completionTokens = Number(usageMeta.candidatesTokenCount ?? 0);
          const totalTokens = Number(usageMeta.totalTokenCount ?? 0) || promptTokens + completionTokens;
          if (totalTokens > 0) {
            const cached = Number(usageMeta.cachedContentTokenCount ?? 0);
            const reasoning = Number(usageMeta.thoughtsTokenCount ?? 0);
            usage = {
              promptTokens,
              completionTokens,
              totalTokens,
              ...(cached > 0 ? { cachedPromptTokens: cached } : {}),
              ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
            };
          }
        }
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought) {
            callbacks.onThinking?.();
          } else if (part.text) {
            reply += part.text;
            callbacks.onText?.(part.text);
          } else if (part.functionCall) {
            toolCalls.push({
              id: `gcall_${(++googleToolCallSequence).toString(36)}`,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              },
            });
          }
        }
      } catch {
        // Ignore malformed or non-JSON SSE data frames.
      }
    };

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

    return { content: reply, toolCalls, usage };
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Error: ${message}`, toolCalls: [] };
  }
}
