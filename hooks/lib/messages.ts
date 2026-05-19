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
    "unsure, record the event with `note: \"speculative; <reason>\"`",
    "instead of skipping — the dream pass discards single-event",
    "speculative entries that do not recur.",
  );
  return parts.join("\n");
}

function stopGuardrailCadenceLine(runtime: HookRuntime): string {
  switch (runtime) {
    case "claudecode":
      return "_This guardrail fires at most once per turn — send another reply (with or without a brain-event call) to clear it._";
    case "codex":
      return "_This `codex exec` is about to end — call `brain_feedback` / `brain_apply_evidence` / `brain_note` now or finish silently; no further guardrail will fire._";
    case "unknown":
      return "";
  }
}

export function stopGuardrailReason(runtime: HookRuntime = "unknown"): string {
  const cadence = stopGuardrailCadenceLine(runtime);
  const parts: string[] = [
    "Open Second Brain hook: this turn touched files",
    "(Write / Edit / MultiEdit / apply_patch) but did not call any of:",
    "",
    "- `brain_feedback` — new taste correction the user expressed in this",
    "  turn (one signal per file, see the `brain-memory` skill)",
    "- `brain_apply_evidence` — evidence trail when an active preference",
    "  in `Brain/preferences/` scopes to the artifact you just produced",
    "- `brain_note` — one-line narrative milestone (release shipped, PR",
    "  merged, fact discovered) that fits neither of the first two",
    "",
  ];
  if (cadence !== "") parts.push(cadence, "");
  parts.push(
    "Pick whichever fits this turn:",
    "- a new rule the user just stated → `brain_feedback`",
    "- an active preference applied, violated, or made obsolete by the",
    "  change → `brain_apply_evidence` with",
    "  `result: applied | violated | outdated`",
    "- a durable narrative milestone → `brain_note`",
    "",
    "If the change is trivial and not worth recording, just send your",
    "reply again — this guardrail fires at most once per turn and the",
    "second Stop passes through silently.",
  );
  return parts.join("\n");
}
