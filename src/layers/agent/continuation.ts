import type { TaskTracker } from "./taskstate";

const CONTINUATION_REQUEST = /^(?:continue|continue the task|continue task|keep going|go on|carry on|resume|resume the task|finish it|finish the task)[.!\s…]*$/i;

/** Reuse the saved objective for short continuation prompts so beginRun preserves the plan. */
export function resolveTaskObjective(message: string, tracker: Pick<TaskTracker, "getObjective">): string {
  const priorObjective = tracker.getObjective().trim();
  return priorObjective && CONTINUATION_REQUEST.test(message.trim())
    ? priorObjective
    : message.trim();
}
