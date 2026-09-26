#!/usr/bin/env -S bun
/**
 * Stop hook: nudges the agent at most once per turn when it produced a
 * durable-looking artifact (Write / Edit / MultiEdit / apply_patch) but
 * recorded no brain event (`brain_feedback` / `brain_apply_evidence` /
 * `brain_note`). The agent decides whether to record or just finish.
 *
 * Output channel per runtime (v1.58.2):
 *
 *   - Claude Code: `hookSpecificOutput.additionalContext` on the Stop
 *     event. Claude Code (2.1.163+) continues the turn with it as
 *     non-error feedback, labelled "Stop hook feedback", instead of the
 *     red "Stop hook error" that `decision: "block"` renders with the
 *     whole reason in the user's transcript.
 *
 *   - Codex, Grok Build and unrecognised runtimes:
 *       {"decision": "block", "reason": "<one line>"}
 *     Codex documents only this shape for Stop (the reason becomes the
 *     continuation prompt), and it is the portable fallback.
 *
 * Either way the text is one short line (`STOP_GUARDRAIL_TEXT`); the
 * details live in the `brain-memory` skill.
 *
 * Fires at most once per turn: when the runtime reports
 * `stop_hook_active === true` (this turn was already continued by a
 * Stop hook) the hook exits 0 silently. No artifact, or a recorded
 * brain event, also exits 0 silently. Crashes exit 0 - never deadlock.
 */

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { readTranscript } from "./lib/transcript.ts";
import { detectHookRuntime, summarizeTurn } from "./lib/detect.ts";
import { stopGuardrailOutput } from "./lib/messages.ts";

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  if (payload.stop_hook_active === true) return;

  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return;

  let signal;
  try {
    signal = readTranscript(transcriptPath);
  } catch {
    return;
  }

  const summary = summarizeTurn(signal.toolCalls, signal.bashCommands);
  if (!summary.hadArtifact || summary.hadBrainEvent) return;

  process.stdout.write(JSON.stringify(stopGuardrailOutput(detectHookRuntime(payload))) + "\n");
}

main().catch(() => {
  // Never deadlock on a hook crash.
});
