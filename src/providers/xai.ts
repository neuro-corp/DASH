import {
  chatOpenAICompatible,
  type GenerationOptions,
  type NvidiaChatMessage,
  type NvidiaChatResult,
  type NvidiaStreamCallbacks,
} from "./nvidia";

const XAI_API_BASE = 'https://api.x.ai/v1';

export async function listXaiModels(apiKey: string) {
  if (!apiKey) return [];
  try {
    const res = await fetch(`${XAI_API_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map(model => model.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export async function chatXai(
  apiKey: string,
  model: string,
  messages: NvidiaChatMessage[],
  tools: readonly unknown[],
  callbacks: NvidiaStreamCallbacks = {},
  generation: GenerationOptions = {},
): Promise<NvidiaChatResult> {
  return chatOpenAICompatible({
    baseUrl: XAI_API_BASE,
    apiKey,
    model,
    messages,
    tools,
    callbacks,
    generation,
  });
}
