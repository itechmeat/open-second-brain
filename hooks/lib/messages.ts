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
 *
 * §4-tail (v0.10.5): a per-runtime cadence line is interpolated
 * between the opening sentence and the rest of the reminder when the
 * payload-shape detector resolves to `claudecode` or `codex`. The
 * `unknown` branch renders byte-identical to the v0.10.4 baseline so
 * old hook installs and unfamiliar runtimes are not affected.
 */

import type { HookRuntime } from "./detect.ts";

export interface PostWriteReminderInput {
  readonly toolName: string;
  readonly filePath: string | null;
  readonly runtime: HookRuntime;
}

function postWriteCadenceLine(runtime: HookRuntime): string {
  switch (runtime) {
    case "claudecode":
      return [
        "_Claude Code session: many turns ahead — capture the signal_",
        "_or evidence now rather than batching to end-of-session; long_",
        "_sessions risk forgetting the context that distinguishes one_",
        "_artifact from the next._",
      ].join("\n");
    case "codex":
      return [
        "_Codex `codex exec` is a one-shot run — call `brain_feedback`_",
        "_or `brain_apply_evidence` before this exec returns; there is_",
        "_no second turn._",
      ].join("\n");
    case "unknown":
      return "";
  }
}

export function postWriteReminder({
  toolName,
  filePath,
  runtime,
}: PostWriteReminderInput): string {
  const target = filePath ? `\`${filePath}\`` : "a file";
  const cadence = postWriteCadenceLine(runtime);
  const parts: string[] = [
    `Open Second Brain hook: you just ran \`${toolName}\` against ${target}.`,
    "",
  ];
  if (cadence !== "") parts.push(cadence, "");
  parts.push(
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
  );
  return parts.join("\n");
}

function stopGuardrailCadenceLine(runtime: HookRuntime): string {
  switch (runtime) {
    case "claudecode":
      return "_This guardrail fires at most once per turn — send another reply (with or without `event_log_append`) to clear it._";
    case "codex":
      return "_This `codex exec` is about to end — call `event_log_append` now or finish silently; no further guardrail will fire._";
    case "unknown":
      return "";
  }
}

export function stopGuardrailReason(runtime: HookRuntime = "unknown"): string {
  const cadence = stopGuardrailCadenceLine(runtime);
  const parts: string[] = [
    "Open Second Brain hook: this turn touched files",
    "(Write / Edit / MultiEdit / apply_patch) but did not call",
    "`event_log_append`.",
    "",
  ];
  if (cadence !== "") parts.push(cadence, "");
  parts.push(
    "If the change is a durable artifact you want future sessions to",
    "be able to search for, call `event_log_append` with a one-line",
    "message describing what landed, then finish.",
    "",
    "If the change is trivial and not worth logging, just send your",
    "reply again — this guardrail fires at most once per turn and",
    "will let the second Stop through.",
  );
  return parts.join("\n");
}
