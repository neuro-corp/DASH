/**
 * Model context-window metadata.
 *
 * DASH models are described authoritatively by the backend (`/api/models`).
 * Other providers expose no capacity metadata, so known families are matched
 * against a local table and anything unrecognised falls back to a safe default.
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_COMPACT_PERCENT = 85;
export const MIN_COMPACT_PERCENT = 85;
export const MAX_COMPACT_PERCENT = 95;
/** Default per-request prompt cap at the 85% threshold, including schemas. */
export const DEFAULT_AGENT_PROMPT_TOKENS = Math.floor(
  (DEFAULT_CONTEXT_WINDOW * DEFAULT_COMPACT_PERCENT) / 100,
) - DEFAULT_MAX_OUTPUT_TOKENS;

/** The smallest prompt budget worth sending to a provider. */
const MIN_PROMPT_BUDGET = 1_000;
/** Output reservation is never allowed to eat more than half the window. */
const MAX_OUTPUT_SHARE = 0.5;

export interface ModelCapacity {
  contextWindow: number;
  maxOutputTokens: number;
}

type CapacityPattern = {
  match: RegExp;
  capacity: ModelCapacity;
};

/**
 * Best-effort capacities for non-DASH providers. Ordered from most specific to
 * least specific; the first match wins.
 */
const CAPACITY_PATTERNS: CapacityPattern[] = [
  { match: /nemotron.*ultra|ultra.*550b/i, capacity: { contextWindow: 256_000, maxOutputTokens: 32_768 } },
  { match: /gemini[-_ ]?1\.5[-_ ]?pro|gemini[-_ ]?2/i, capacity: { contextWindow: 1_000_000, maxOutputTokens: 8_192 } },
  { match: /gemini/i, capacity: { contextWindow: 1_000_000, maxOutputTokens: 8_192 } },
  { match: /claude/i, capacity: { contextWindow: 200_000, maxOutputTokens: 8_192 } },
  { match: /^(o1|o3|o4)(-|$)/i, capacity: { contextWindow: 200_000, maxOutputTokens: 100_000 } },
  { match: /gpt[-_ ]?4\.1/i, capacity: { contextWindow: 128_000, maxOutputTokens: 32_768 } },
  { match: /gpt[-_ ]?4o|gpt[-_ ]?4-turbo/i, capacity: { contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { match: /gpt[-_ ]?4/i, capacity: { contextWindow: 128_000, maxOutputTokens: 8_192 } },
  { match: /gpt[-_ ]?3\.5/i, capacity: { contextWindow: 16_385, maxOutputTokens: 4_096 } },
  { match: /grok/i, capacity: { contextWindow: 256_000, maxOutputTokens: 16_384 } },
  { match: /deepseek/i, capacity: { contextWindow: 128_000, maxOutputTokens: 8_192 } },
  { match: /muse[-_ ]?glimmer/i, capacity: { contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { match: /nemotron/i, capacity: { contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { match: /llama|mistral|mixtral|qwen|command[-_ ]?r/i, capacity: { contextWindow: 128_000, maxOutputTokens: 8_192 } },
];

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

/**
 * Resolve the effective capacity for a model.
 *
 * Declared values (from the DASH backend) win over the local pattern table.
 * Nonsensical declarations are ignored rather than trusted, because a bad
 * window would either corrupt compaction or overflow the provider request.
 */
export function resolveModelCapacity(
  model: string,
  declared?: Partial<ModelCapacity> | null,
): ModelCapacity {
  const known = CAPACITY_PATTERNS.find(pattern => pattern.match.test(model || ''))?.capacity;
  const fallback = known ?? {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };

  const declaredWindow = positiveInteger(declared?.contextWindow);
  const declaredOutput = positiveInteger(declared?.maxOutputTokens);
  const contextWindow = declaredWindow && declaredWindow >= MIN_PROMPT_BUDGET
    ? declaredWindow
    : fallback.contextWindow;

  const outputCeiling = Math.max(256, Math.floor(contextWindow * MAX_OUTPUT_SHARE));
  const maxOutputTokens = declaredOutput
    ? Math.min(declaredOutput, outputCeiling)
    : Math.min(fallback.maxOutputTokens, outputCeiling);

  return { contextWindow, maxOutputTokens };
}

/** Clamp the auto-compaction threshold to the supported 85–95% band. */
export function clampCompactPercent(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_COMPACT_PERCENT;
  return Math.min(MAX_COMPACT_PERCENT, Math.max(MIN_COMPACT_PERCENT, Math.round(parsed)));
}

/**
 * Tokens available for the prompt before auto-compaction fires.
 *
 * Compact when the prompt plus its completion reservation would reach the
 * configured share of the model's total context window. An explicit `hardCap`
 * (`agent.maxPromptTokens`) may lower this threshold, but is never applied by
 * default in the interactive app.
 */
export function computePromptBudget(options: {
  contextWindow: number;
  maxOutputTokens: number;
  compactPercent?: number;
  hardCap?: number;
}): number {
  const contextWindow = positiveInteger(options.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = Math.max(
    0,
    Math.min(positiveInteger(options.maxOutputTokens) ?? 0, Math.floor(contextWindow * MAX_OUTPUT_SHARE)),
  );
  const percent = clampCompactPercent(options.compactPercent);
  const budget = Math.floor((contextWindow * percent) / 100) - maxOutputTokens;
  const capped = positiveInteger(options.hardCap);
  return Math.max(MIN_PROMPT_BUDGET, capped ? Math.min(budget, capped) : budget);
}

/** Share of the context window currently used, as a 0–100 number. */
export function contextUsagePercent(usedTokens: number, contextWindow: number): number {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(100, (usedTokens / contextWindow) * 100);
}
