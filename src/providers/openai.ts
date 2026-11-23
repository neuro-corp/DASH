import {
  chatOpenAICompatible,
  type GenerationOptions,
  type NvidiaChatMessage,
  type NvidiaChatResult,
  type NvidiaStreamCallbacks,
} from "./nvidia";

const OPENAI_API_BASE = 'https://api.openai.com/v1';

export async function listOpenAIModels(apiKey: string) {
  if (!apiKey) return [];
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string }> };
    const ids = (data.data ?? []).map(m => m.id).filter(Boolean);
    return ids;
  } catch {
    return [];
  }
}

export async function chatOpenAI(
  apiKey: string,
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks = {},
  generation: GenerationOptions = {},
): Promise<NvidiaChatResult> {
  return chatOpenAICompatible({
    baseUrl: OPENAI_API_BASE,
    apiKey,
    model,
    messages,
    tools,
    callbacks,
    generation,
  });
}
