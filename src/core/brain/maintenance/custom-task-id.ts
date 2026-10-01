/**
 * The identity of an install-owned custom maintenance lane task: the
 * `custom:<name>` form and its well-formedness check, with no imports.
 *
 * The lane kernel and the journal need only this to widen their task
 * identities and to count a custom task's timeouts toward its streak.
 * Keeping it in a leaf module lets them do that without importing the
 * runner in `custom-tasks.ts`, which itself reads the machine config and
 * the lane's lease length, and would otherwise close an import cycle
 * through the lane kernel.
 */

export const CUSTOM_TASK_PREFIX = "custom:";
export const CUSTOM_TASK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type CustomLaneTask = `custom:${string}`;

/** Whether `value` is a well-formed custom identity (not whether it is declared). */
export function isCustomLaneTask(value: unknown): value is CustomLaneTask {
  return (
    typeof value === "string" &&
    value.startsWith(CUSTOM_TASK_PREFIX) &&
    CUSTOM_TASK_NAME_PATTERN.test(value.slice(CUSTOM_TASK_PREFIX.length))
  );
}
