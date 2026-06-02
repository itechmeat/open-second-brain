/**
 * Hook event names allowed to carry
 * `hookSpecificOutput.additionalContext` back to the runtime.
 *
 * Default-closed: any event not listed here gets NO stdout from
 * context-injecting hooks. Claude Code validates hook output against a
 * per-event schema and rejects `additionalContext` for events that do
 * not support it - the rejection both drops the payload and echoes it
 * into the validation error, so emitting on an unsupported event is
 * strictly worse than staying silent.
 *
 * `PostCompact` is deliberately absent: current Claude Code has no
 * such hook event at all (verified against
 * https://code.claude.com/docs/en/hooks, 2026-06-02). Post-compaction
 * re-injection is served by the `SessionStart` hook with the
 * `compact` matcher instead - see `hooks/hooks.json`.
 */

export const CONTEXT_EVENT_NAMES = Object.freeze(["SessionStart", "UserPromptSubmit"] as const);

export type ContextEventName = (typeof CONTEXT_EVENT_NAMES)[number];

export function isContextEventName(name: string): name is ContextEventName {
  return (CONTEXT_EVENT_NAMES as ReadonlyArray<string>).includes(name);
}
