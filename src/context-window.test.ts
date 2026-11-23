import { describe, expect, it } from "bun:test";
import {
  DEFAULT_AGENT_PROMPT_TOKENS,
  DEFAULT_COMPACT_PERCENT,
  DEFAULT_CONTEXT_WINDOW,
  clampCompactPercent,
  computePromptBudget,
  contextUsagePercent,
  resolveModelCapacity,
} from "./context-window";

describe("model context capacity", () => {
  it("prefers capacities declared by the DASH backend", () => {
    const capacity = resolveModelCapacity("nvidia/nemotron-3.5-lightning-30b-a3b", {
      contextWindow: 200_000,
      maxOutputTokens: 20_000,
    });
    expect(capacity).toEqual({ contextWindow: 200_000, maxOutputTokens: 20_000 });
  });

  it("falls back to the local table for other providers", () => {
    expect(resolveModelCapacity("gemini-2.5-pro").contextWindow).toBe(1_000_000);
    expect(resolveModelCapacity("gpt-4.1").contextWindow).toBe(128_000);
    expect(resolveModelCapacity("claude-sonnet-4").contextWindow).toBe(200_000);
  });

  it("uses the safe default for unknown models and rejects nonsense declarations", () => {
    expect(resolveModelCapacity("some-model").contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveModelCapacity("some-model", { contextWindow: -1, maxOutputTokens: 0 }).contextWindow)
      .toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveModelCapacity("some-model", { contextWindow: 128_000, maxOutputTokens: 999_999 }).maxOutputTokens)
      .toBe(64_000);
  });

  it("clamps the compaction threshold to 85–95%", () => {
    expect(clampCompactPercent(undefined)).toBe(DEFAULT_COMPACT_PERCENT);
    expect(clampCompactPercent(50)).toBe(85);
    expect(clampCompactPercent(200)).toBe(95);
    expect(clampCompactPercent(87.6)).toBe(88);
  });

  it("uses the configured default compaction threshold without an early prompt cap", () => {
    expect(DEFAULT_AGENT_PROMPT_TOKENS).toBe(92_416);
    expect(computePromptBudget({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      compactPercent: DEFAULT_COMPACT_PERCENT,
    })).toBe(92_416);
  });

  it("reserves output tokens before applying the threshold", () => {
    // 128,000 * 90% - 16,384 = 98,816
    expect(computePromptBudget({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      compactPercent: 90,
    })).toBe(98_816);

    // A legacy hard cap may only lower the physical budget.
    expect(computePromptBudget({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      compactPercent: 90,
      hardCap: 60_000,
    })).toBe(60_000);
    expect(computePromptBudget({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      compactPercent: 90,
      hardCap: 900_000,
    })).toBe(98_816);
  });

  it("reports context usage as a clamped percentage", () => {
    expect(contextUsagePercent(32_000, 128_000)).toBe(25);
    expect(contextUsagePercent(0, 128_000)).toBe(0);
    expect(contextUsagePercent(999_999, 128_000)).toBe(100);
    expect(contextUsagePercent(1_000, 0)).toBe(0);
  });
});
