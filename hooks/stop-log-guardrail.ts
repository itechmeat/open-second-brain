#!/usr/bin/env -S bun
/**
 * Stop hook: blocks the turn at most once when the agent produced a
 * durable-looking artifact (Write / Edit / MultiEdit / apply_patch) but
 * never called `event_log_append`. Lets the agent decide whether to log
 * or finish — but forces the decision to be conscious.
 *
 * Decision shape (identical for Claude Code and Codex):
 *
 *   - On the first Stop of a turn (`stop_hook_active === false` and the
 *     artifact-without-log condition holds): emit
 *       {"decision": "block", "reason": "<text>"}
 *     so the runtime continues the agent loop with that reason injected
 *     as a developer message. The agent can then either call
 *     `event_log_append` or just finish; either way the next Stop sees
 *     `stop_hook_active === true` and passes through.
 *
 *   - On any Stop where the guardrail already fired
 *     (`stop_hook_active === true`): exit 0 silently. No deadlocks.
 *
 *   - On any Stop where there was no artifact or a log was made: exit 0
 *     silently.
 *
 * The guardrail never blocks twice in a row by design — that matches
 * the user's "agent decides what to log" requirement.
 */

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { readTranscript } from "./lib/transcript.ts";
import { summarizeTurn } from "./lib/detect.ts";
import { stopGuardrailReason } from "./lib/messages.ts";

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
  if (!summary.hadArtifact || summary.hadLog) return;

  const out = {
    decision: "block",
    reason: stopGuardrailReason(),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch(() => {
  // Never deadlock on a hook crash.
});
