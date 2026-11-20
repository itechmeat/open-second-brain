#!/usr/bin/env -S bun
/**
 * Stop hook: nudges the agent at most once per turn when it produced a
 * durable-looking artifact (Write / Edit / MultiEdit / apply_patch) but
 * recorded no brain event (`brain_feedback` / `brain_apply_evidence` /
 * `brain_note`). The agent decides whether to record or just finish.
 *
 * Output channel per runtime:
 *
 *   - Claude Code (default `stop_advisory_delivery: "async"`): this hook
 *     stays synchronous and prints nothing. It hands the line over
 *     (hooks/lib/stop-advisory-handover.ts) to the async
 *     `stop-advisory-deliver` hook, whose `additionalContext` reaches the
 *     model with the next user message, unprinted and without a turn of its
 *     own (`STOP_GUARDRAIL_DEFERRED_TEXT`, "the previous turn").
 *
 *   - Claude Code with `stop_advisory_delivery: "sync"`: synchronous
 *     `hookSpecificOutput.additionalContext` with `STOP_GUARDRAIL_TEXT`. Claude
 *     Code prints it as "Stop hook says: ..." and continues the turn once -
 *     the form for one-shot `claude -p` runs, which kill async hooks at
 *     teardown.
 *
 *   - Codex, Grok Build and unrecognised runtimes:
 *       {"decision": "block", "reason": "<one line>"}
 *     Codex documents only this shape for Stop (the reason becomes the
 *     continuation prompt), and it is the portable fallback.
 *
 * Either way the text is one short line (`STOP_GUARDRAIL_DEFERRED_TEXT`
 * when handed over, `STOP_GUARDRAIL_TEXT` when printed here); the details
 * live in the `brain-memory` skill.
 *
 * `stop_guardrail_enabled: "false"` (machine config, env
 * `OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED`) turns the hook off.
 *
 * Fires at most once per turn: when the runtime reports
 * `stop_hook_active === true` (this turn was already continued by a
 * Stop hook) the hook exits 0 silently. No artifact, or a recorded
 * brain event, also exits 0 silently. Crashes exit 0 - never deadlock.
 */

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { readTranscript } from "./lib/transcript.ts";
import { detectHookRuntime, summarizeTurn } from "./lib/detect.ts";
import { STOP_GUARDRAIL_DEFERRED_TEXT, stopGuardrailOutput } from "./lib/messages.ts";
import { stopAdvisoryHandsOver, writeStopAdvisoryHandover } from "./lib/stop-advisory-handover.ts";
import { resolveStopGuardrailEnabled } from "../src/core/config.ts";

/** Whether this turn changed files and recorded no brain event. */
function guardrailFires(transcriptPath: unknown): boolean {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return false;
  let signal;
  try {
    signal = readTranscript(transcriptPath);
  } catch {
    return false;
  }
  const summary = summarizeTurn(signal.toolCalls, signal.bashCommands);
  return summary.hadArtifact && !summary.hadBrainEvent;
}

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  if (payload.stop_hook_active === true) return;
  if (!resolveStopGuardrailEnabled()) return;

  const handsOver = stopAdvisoryHandsOver(payload);
  let fires = false;
  try {
    fires = guardrailFires(payload.transcript_path);
  } finally {
    // Past the switch the deliver hook waits for this producer, so the
    // hand-over is written on every path, "nothing" included.
    if (handsOver) {
      writeStopAdvisoryHandover(
        payload,
        "stop-log-guardrail",
        fires ? STOP_GUARDRAIL_DEFERRED_TEXT : null,
      );
    }
  }
  if (handsOver || !fires) return;

  process.stdout.write(JSON.stringify(stopGuardrailOutput(detectHookRuntime(payload))) + "\n");
}

main().catch(() => {
  // Never deadlock on a hook crash.
});
