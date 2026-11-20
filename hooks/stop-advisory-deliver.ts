#!/usr/bin/env -S bun
/**
 * Async Stop hook (Claude Code only): prints the end-of-turn advisories the
 * synchronous Stop hooks handed over (hooks/lib/stop-advisory-handover.ts).
 *
 * The producers - `stop-log-guardrail`, `answer-quote-check` and
 * `hygiene-digest` - run as synchronous hooks, do every read and every
 * durable write, print nothing, and leave their text in a device-local file.
 * This hook runs as an `async` entry in hooks/hooks.json, so Claude Code
 * hands its `additionalContext` to the model with the next user message, does
 * not print it in the chat, and starts no model turn for it. It only reads,
 * removes and prints: if a one-shot `claude -p` run kills it at teardown,
 * only the advisory text is lost.
 *
 * Gates (all silent):
 *   1. Unreadable payload, or `stop_hook_active === true`.
 *   2. Not Claude Code, `stop_advisory_delivery: "sync"`, or no session id:
 *      the producers printed their own synchronous form, nothing was handed
 *      over.
 *   3. No producer enabled: nothing will be handed over, so no wait.
 *
 * Output: one `hookSpecificOutput.additionalContext` with the advisories in
 * producer order, separated by a blank line. Crashes exit 0.
 */

import {
  resolveHygieneDigestEnabled,
  resolveQuoteCheckEnabled,
  resolveStopGuardrailEnabled,
} from "../src/core/config.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import {
  stopAdvisoryHandsOver,
  takeStopAdvisories,
  type StopAdvisoryProducer,
} from "./lib/stop-advisory-handover.ts";

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }
  if (payload.stop_hook_active === true) return;
  if (!stopAdvisoryHandsOver(payload)) return;

  // Wait only for the producers that will write: a switched-off producer
  // returns before its hand-over.
  const expected: StopAdvisoryProducer[] = [];
  if (resolveStopGuardrailEnabled()) expected.push("stop-log-guardrail");
  if (resolveQuoteCheckEnabled()) expected.push("answer-quote-check");
  if (resolveHygieneDigestEnabled()) expected.push("hygiene-digest");
  if (expected.length === 0) return;

  const advisories = takeStopAdvisories(payload, expected);
  if (advisories.length === 0) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: advisories.join("\n\n") },
    })}\n`,
  );
}

main().catch(() => {
  // Never deadlock on a hook crash.
});
