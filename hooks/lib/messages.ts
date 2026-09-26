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
    case "grok":
      return [
        "_Grok Build session: many turns ahead — capture the signal or_",
        "_evidence now rather than batching to end-of-session; long_",
        "_sessions risk forgetting the context that distinguishes one_",
        "_artifact from the next._",
      ].join("\n");
    case "unknown":
      return "";
  }
}

export function postWriteReminder({ toolName, filePath, runtime }: PostWriteReminderInput): string {
  const target = filePath ? `\`${filePath}\`` : "a file";
  const cadence = postWriteCadenceLine(runtime);
  const parts: string[] = [
    `Open Second Brain hook: you just ran \`${toolName}\` against ${target}.`,
    "",
  ];
  if (cadence !== "") parts.push(cadence, "");
  parts.push(
    "If this turn contained a user preference, correction, or rule that",
    'should outlast the current task ("don\'t do X", "prefer Y", "use',
    'A instead of B"), call `brain_feedback` once per signal to record',
    "it into `Brain/inbox/`.",
    "",
    "If a confirmed or unconfirmed preference in `Brain/preferences/`",
    "scopes to the artifact you just produced, call",
    "`brain_apply_evidence` with `result: applied | violated | outdated`",
    "so the dream pass can update confidence and retire stale rules.",
    "",
    "If neither a new preference nor an evidence event fits but this",
    "turn still produced a durable artifact worth referencing later",
    "(release shipped, PR merged, fact discovered), call `brain_note`",
    "with a one-line description — it lands in `Brain/log/<today>.md`",
    "(plus the JSONL sidecar) under the `note` event kind.",
    "",
    "Trivial edits (typo fix, pure formatting) don't need any of the",
    "three calls. When a preference plausibly applies but you are",
    'unsure, record the event with `note: "speculative; <reason>"`',
    "instead of skipping — the dream pass discards single-event",
    "speculative entries that do not recur.",
  );
  return parts.join("\n");
}

/**
 * End-of-turn guardrail text (v1.58.2). One line on purpose: Claude Code
 * renders it in the user's transcript and Codex turns it into a
 * continuation prompt, so every extra line is noise the operator reads
 * on each guarded turn. The full contract lives in the `brain-memory`
 * skill ("End-of-turn check") and in the PostToolUse reminder the model
 * already received after the write.
 */
export const STOP_GUARDRAIL_TEXT =
  "Open Second Brain: this turn changed files but recorded no brain event. " +
  "Call brain_feedback, brain_apply_evidence or brain_note if one fits " +
  "(brain-memory skill); otherwise just finish.";

export type StopGuardrailOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "Stop";
        readonly additionalContext: string;
      };
    }
  | { readonly decision: "block"; readonly reason: string };

/**
 * Hook output for the Stop guardrail. Claude Code gets the non-error
 * `additionalContext` channel; every other runtime gets the portable
 * `decision: "block"` shape. Both continue the turn once and carry the
 * same one-line text.
 */
export function stopGuardrailOutput(runtime: HookRuntime): StopGuardrailOutput {
  if (runtime === "claudecode") {
    return {
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_GUARDRAIL_TEXT },
    };
  }
  return { decision: "block", reason: STOP_GUARDRAIL_TEXT };
}

/**
 * Steady-state nudge (token-diet, t_9cc4f400): emitted after the full
 * reminder has already been shown once in the current Claude Code
 * session. Hard ceiling 200 characters - the whole point is that the
 * per-edit cost stays negligible over a long coding session.
 */
export function postWriteNudge(): string {
  return (
    "Open Second Brain: artifact written. If a taste signal or scoped " +
    "preference applies, call brain_feedback / brain_apply_evidence / " +
    "brain_note (full contract earlier in this session)."
  );
}
