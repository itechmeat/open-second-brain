/**
 * Hook-side reminder texts. Kept in one module so the wording stays
 * consistent across the PostToolUse reminder and the Stop guardrail,
 * and so it can be tested without spinning up a hook process.
 *
 * The text is deliberately written for the LLM consumer (a coding
 * agent), not the human user — the human only ever sees a status
 * line. Tone: factual, terse, no exclamation marks, no apology.
 *
 * These messages are emitted in English because the hooks run in the
 * agent's runtime, not in a conversation context — the language
 * choice for the *event log entry itself* still follows the
 * conversation locale per the `agent-event-log` skill.
 */

export interface PostWriteReminderInput {
  readonly toolName: string;
  readonly filePath: string | null;
}

export function postWriteReminder({ toolName, filePath }: PostWriteReminderInput): string {
  const target = filePath ? `\`${filePath}\`` : "a file";
  return [
    `Open Second Brain hook: you just ran \`${toolName}\` against ${target}.`,
    "",
    "If this turn contained a user preference, correction, or rule that",
    "should outlast the current task (\"don't do X\", \"prefer Y\", \"use",
    "A instead of B\"), call `brain_feedback` once per signal to record",
    "it into `Brain/inbox/`.",
    "",
    "If a confirmed or unconfirmed preference in `Brain/preferences/`",
    "scopes to the artifact you just produced, call",
    "`brain_apply_evidence` with `result: applied | violated` so the",
    "dream pass can update confidence and retire stale rules.",
    "",
    "Trivial edits (typo fix, pure formatting) don't need either call.",
    "A misrecorded signal is worse than a missed one — skip when not",
    "confident; the dream pass will pick up patterns from repeats.",
  ].join("\n");
}

export function stopGuardrailReason(): string {
  return [
    "Open Second Brain hook: this turn touched files",
    "(Write / Edit / MultiEdit / apply_patch) but did not call",
    "`event_log_append`.",
    "",
    "If the change is a durable artifact you want future sessions to",
    "be able to search for, call `event_log_append` with a one-line",
    "message describing what landed, then finish.",
    "",
    "If the change is trivial and not worth logging, just send your",
    "reply again — this guardrail fires at most once per turn and",
    "will let the second Stop through.",
  ].join("\n");
}
