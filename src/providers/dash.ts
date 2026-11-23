import type {
  GenerationOptions,
  NvidiaChatMessage,
  NvidiaChatResult,
  NvidiaStreamCallbacks,
  NvidiaToolCall,
  NvidiaUsage,
} from "./nvidia";
import { appendStreamFragment, ensureUniqueToolCallIds } from "./nvidia";
import { getDeviceId } from "../device";

const DASH_BACKEND_URL = "https://neuro-dash-backend-production.up.railway.app/";

export interface DashQuota {
  limit: number;
  remaining: number;
  resetAt: string;
  day?: string;
}

export interface DashChatResult extends NvidiaChatResult {
  quota?: DashQuota;
}

export interface DashRequestOptions {
  /** Overrides the locally derived device ID (tests, tooling). */
  deviceId?: string;
}

type DashStreamChunk = {
  error?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

function sanitizeMessage(text: string): string {
  return text
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function errorMessageFromPayload(payload: unknown): string | undefined {
  if (typeof payload === "string") return sanitizeMessage(payload) || undefined;
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return sanitizeMessage(record.error) || undefined;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") return sanitizeMessage(nested.message) || undefined;
  }
  if (typeof record.message === "string") return sanitizeMessage(record.message) || undefined;
  if (typeof record.detail === "string") return sanitizeMessage(record.detail) || undefined;
  return undefined;
}

function fallbackStatusMessage(status: number): string {
  if (status === 400) return "The chat request was rejected. Check the selected model and conversation.";
  if (status === 404) return "The selected model is not available. Choose another model with /models.";
  if (status === 413) return "The conversation is too large to send.";
  if (status === 429) return "The model is rate limited. Please try again shortly.";
  if (status === 502 || status === 503) return "The backend could not reach the AI provider.";
  if (status >= 500) return "The backend failed to generate a response.";
  return `The backend returned an error (HTTP ${status}).`;
}

async function readResponseError(res: Response): Promise<string> {
  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data: unknown = await res.json();
      const message = errorMessageFromPayload(data);
      if (message) {
        const resetAt = data && typeof data === "object"
          ? (data as { resetAt?: unknown }).resetAt
          : undefined;
        return typeof resetAt === "string" && !message.includes(resetAt)
          ? `${message} Resets at ${resetAt}.`
          : message;
      }
    }
  } catch {
    // Fall through to the status-based message.
  }
  return fallbackStatusMessage(res.status);
}

function readQuota(res: Response): DashQuota | undefined {
  const limit = Number(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const resetAt = res.headers.get("x-ratelimit-reset") ?? "";
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !resetAt) return undefined;
  const day = res.headers.get("x-ratelimit-day") ?? undefined;
  return { limit, remaining, resetAt, ...(day ? { day } : {}) };
}

function toWireMessages(messages: NvidiaChatMessage[]) {
  return messages.map(message => ({
    role: message.role,
    content: message.content ?? null,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
}

export async function chatDash(
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks = {},
  generation: GenerationOptions = {},
  options: DashRequestOptions = {},
): Promise<DashChatResult> {
  let deviceId = options.deviceId ?? "";
  if (!deviceId) {
    try {
      deviceId = getDeviceId();
    } catch {
      deviceId = "";
    }
  }

  let res: Response;
  try {
    res = await fetch(`${DASH_BACKEND_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(deviceId ? { "X-Device-Id": deviceId, "X-Device-Platform": process.platform } : {}),
      },
      body: JSON.stringify({
        model,
        messages: toWireMessages(messages),
        ...(tools.length > 0 ? { tools } : {}),
        temperature: generation.temperature ?? 1,
        top_p: generation.topP ?? 0.95,
        max_tokens: generation.maxOutputTokens ?? 16384,
        ...(generation.reasoningEffort ? { reasoning_effort: generation.reasoningEffort } : {}),
        stream: true,
      }),
      signal: callbacks.signal,
    });
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Error: Could not reach the Dash backend (${DASH_BACKEND_URL}). ${sanitizeMessage(message)}`,
      toolCalls: [],
    };
  }

  const quota = readQuota(res);

  if (!res.ok) {
    return { content: `Error: ${await readResponseError(res)}`, toolCalls: [], ...(quota ? { quota } : {}) };
  }
  if (!res.body) {
    return { content: "Error: The Dash backend returned an empty response stream.", toolCalls: [], ...(quota ? { quota } : {}) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let usage: NvidiaUsage | undefined;
  let sawDone = false;
  let finishReason: string | null = null;
  let streamError: string | undefined;
  const toolCalls: NvidiaToolCall[] = [];

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }

    let chunk: DashStreamChunk;
    try {
      chunk = JSON.parse(payload) as DashStreamChunk;
    } catch {
      // A malformed frame is ignored; the rest of the stream can still be used.
      return;
    }

    const chunkError = errorMessageFromPayload(chunk);
    if (chunkError) {
      streamError = chunkError;
      return;
    }
    if (streamError) return;

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;

    if (delta.reasoning_content) callbacks.onThinking?.();
    if (delta.content) {
      reply += delta.content;
      callbacks.onText?.(delta.content);
    }
    for (const fragment of delta.tool_calls ?? []) {
      const current = toolCalls[fragment.index] ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      current.id = appendStreamFragment(current.id, fragment.id);
      current.function.name = appendStreamFragment(current.function.name, fragment.function?.name);
      current.function.arguments += fragment.function?.arguments ?? "";
      toolCalls[fragment.index] = current;
    }
  };

  try {
    while (!streamError) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Network chunks do not align with SSE frames: only complete lines are
      // processed, and the trailing partial line stays buffered.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (!streamError && buffer.trim()) processLine(buffer);
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!reply && toolCalls.length === 0) {
      return { content: `Error: The response stream failed. ${sanitizeMessage(message)}`, toolCalls: [], ...(quota ? { quota } : {}) };
    }
    streamError = message;
  } finally {
    await reader.cancel().catch(() => {});
  }

  const hasToolCalls = toolCalls.some(Boolean);
  if (streamError) {
    const suffix = `\n\n[Generation failed: ${sanitizeMessage(streamError)}]`;
    return {
      content: reply ? `${reply}${suffix}` : `Error: ${streamError}`,
      toolCalls: ensureUniqueToolCallIds(toolCalls.filter(Boolean)),
      usage,
      ...(quota ? { quota } : {}),
    };
  }

  const interrupted = !sawDone && !finishReason;
  if (!reply && !hasToolCalls) {
    return {
      content: interrupted
        ? "Error: The response stream ended before any content was generated."
        : "Error: The model returned an empty response.",
      toolCalls: [],
      usage,
      ...(quota ? { quota } : {}),
    };
  }

  return {
    content: interrupted && reply ? `${reply}\n\n[Response interrupted before completion]` : reply,
    toolCalls: ensureUniqueToolCallIds(toolCalls.filter(Boolean)),
    usage,
    ...(quota ? { quota } : {}),
  };
}

/** Fetch today's quota for a device from the backend (null when unavailable). */
export async function getDashQuota(deviceId?: string): Promise<(DashQuota & { used: number; requests?: number; estimated?: boolean }) | null> {
  let id = deviceId ?? "";
  if (!id) {
    try {
      id = getDeviceId();
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(`${DASH_BACKEND_URL}/api/quota`, {
      headers: { Accept: "application/json", "X-Device-Id": id },
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const quota = data.quota && typeof data.quota === "object"
      ? data.quota as Record<string, unknown>
      : null;
    if (data.success !== true || !quota) return null;
    const limit = Number(quota.limit);
    const used = Number(quota.used);
    const remaining = Number(quota.remaining);
    const resetAt = typeof quota.resetAt === "string" ? quota.resetAt : "";
    if (!Number.isFinite(limit) || limit <= 0
      || !Number.isFinite(used) || used < 0 || !Number.isFinite(remaining) || remaining < 0 || !resetAt) {
      return null;
    }
    return {
      limit,
      used,
      remaining,
      resetAt,
      ...(typeof quota.requests === "number" ? { requests: quota.requests } : {}),
      ...(typeof quota.day === "string" ? { day: quota.day } : {}),
      ...(quota.estimated === true ? { estimated: true } : {}),
    };
  } catch {
    return null;
  }
}
