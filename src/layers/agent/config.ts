/**
 * Central agent execution configuration.
 *
 * The step budget counts model iterations (one provider response), not tool
 * calls. A single model response may request many tools, so 50 steps can cover
 * a large task without turning every tool invocation into a separate step.
 */
export const MAX_AGENT_STEPS = 50;

/** Absolute safety ceiling. A profile may lower the budget, never exceed this. */
export const HARD_MAX_AGENT_STEPS = 200;

export const MIN_AGENT_STEPS = 1;

/**
 * Resolve an internally supplied step budget for an agent profile. Invalid
 * values fall back to the default so a malformed config can never disable the
 * loop bound.
 */
export function resolveAgentStepLimit(value?: number | null): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested < MIN_AGENT_STEPS) return MAX_AGENT_STEPS;
  return Math.max(MIN_AGENT_STEPS, Math.min(Math.trunc(requested), HARD_MAX_AGENT_STEPS));
}

/** Number of steps remaining after `used` model iterations. */
export function remainingAgentSteps(used: number, limit = MAX_AGENT_STEPS): number {
  return Math.max(0, resolveAgentStepLimit(limit) - Math.max(0, Math.trunc(used)));
}

/**
 * True when the next model iteration (`used` already consumed) is the last
 * permitted one and must be a tool-free final report.
 */
export function isFinalAgentStep(used: number, limit = MAX_AGENT_STEPS): boolean {
  return remainingAgentSteps(used, limit) <= 1;
}
