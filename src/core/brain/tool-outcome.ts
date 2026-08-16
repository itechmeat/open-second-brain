/**
 * One reading of a host's `tool_response`, shared by every hook that has
 * to know whether the call it is reacting to actually succeeded.
 *
 * Two hooks fire AFTER a tool ran and both must skip a failure: the
 * post-write reminder must not nudge about an edit that never landed, and
 * lifecycle capture must not replay a `brain_feedback` call the host
 * refused - a replayed failure mints a signal for a write that did not
 * happen, which is the opposite of a record.
 *
 * The shape is Claude Code's: a failed tool result carries
 * `is_error: true`. `success: false` is accepted alongside it because the
 * grok payload spells the same verdict that way. A response the host said
 * nothing about is NOT a failure - absence of a verdict is not a verdict,
 * and treating it as one would silence every runtime that does not report
 * per-call outcomes at all.
 */

export function isToolResponseError(response: unknown): boolean {
  if (response === null || typeof response !== "object") return false;
  const record = response as Record<string, unknown>;
  return record["is_error"] === true || record["success"] === false;
}
