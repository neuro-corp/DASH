import { describe, expect, it } from 'bun:test';
import {
  HARD_MAX_AGENT_STEPS,
  MAX_AGENT_STEPS,
  MIN_AGENT_STEPS,
  isFinalAgentStep,
  remainingAgentSteps,
  resolveAgentStepLimit,
} from './config';

describe('agent step config', () => {
  it('centralizes the default step budget', () => {
    expect(MAX_AGENT_STEPS).toBe(50);
    expect(HARD_MAX_AGENT_STEPS).toBe(200);
    expect(MIN_AGENT_STEPS).toBe(1);
  });

  it('allows a bounded internal override and rejects invalid values', () => {
    expect(resolveAgentStepLimit(undefined)).toBe(MAX_AGENT_STEPS);
    expect(resolveAgentStepLimit(null)).toBe(MAX_AGENT_STEPS);
    expect(resolveAgentStepLimit(10)).toBe(10);
    expect(resolveAgentStepLimit(10.9)).toBe(10);
    expect(resolveAgentStepLimit(HARD_MAX_AGENT_STEPS + 1)).toBe(HARD_MAX_AGENT_STEPS);
    expect(resolveAgentStepLimit(0)).toBe(MAX_AGENT_STEPS);
    expect(resolveAgentStepLimit(-5)).toBe(MAX_AGENT_STEPS);
    expect(resolveAgentStepLimit(Number.NaN)).toBe(MAX_AGENT_STEPS);
  });

  it('reports remaining steps and the final iteration', () => {
    expect(remainingAgentSteps(0)).toBe(MAX_AGENT_STEPS);
    expect(remainingAgentSteps(49)).toBe(1);
    expect(remainingAgentSteps(50)).toBe(0);
    expect(remainingAgentSteps(60)).toBe(0);
    expect(isFinalAgentStep(48)).toBe(false);
    expect(isFinalAgentStep(49)).toBe(true);
    expect(isFinalAgentStep(50)).toBe(true);
    expect(isFinalAgentStep(0, 1)).toBe(true);
  });
});
