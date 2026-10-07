#!/usr/bin/env -S bun
/**
 * PostToolUse hook: delivers the operator's standing-rules block into a
 * delegated sub-agent's turn (context-injection-pipeline).
 *
 * The session-start digest never reaches a sub-agent: SessionStart fires
 * once for the main thread, while the agent that performs the actual
 * writes can be exactly the one running without the operator's rules.
 * This carrier closes that gap on the one channel a subagent turn
 * exposes - its write-shaped tool calls, which are the moments learned
 * rules govern - and stays silent for read-only subagents.
 *
 * Contract (identical for Claude Code and Codex):
 *   stdin: hook payload JSON with `tool_name`, `tool_input`, and the
 *     host-assigned `agent_id` that marks a tool call made inside a
 *     delegated sub-agent.
 *   stdout: nothing, or one line naming the operator's standing rules:
 *     - claudecode:
 *       { "hookSpecificOutput": { "hookEventName": "PostToolUse",
 *                                 "additionalContext": "<block>" } }
 *     - every other runtime gets the portable fallback shape,
 *       { "decision": "block", "reason": "<block>" }, the same
 *       arrangement the Stop guardrail makes for non-claudecode
 *       runtimes. The per-runtime helper is local to this file so
 *       hooks/lib/messages.ts stays untouched.
 *
 * Exactly once per sub-agent: the delivered agent ids live in the
 * per-session hook-state ledger (`osb.subagent_inject.delivered`, capped,
 * 24 h TTL). The id is recorded AFTER the stdout write - lose-not-
 * duplicate, like every carrier in this tree - so a second call with the
 * same id is silent and a crash between write and record re-delivers
 * rather than losing the rules.
 *
 * Silent on every empty-handed path, exit 0: no non-empty `agent_id`
 * (the main thread is served by active-inject), a tool outside the
 * write set, no real session id (the ledger needs a session scope; a
 * sessionless host would re-deliver on every call), no vault, an absent
 * or empty rules file (the steady state is an operator who wrote no
 * rules). A rules read that FAILED is not silent: it delivers the
 * explicit failure block naming the path, because a subagent must never
 * mistake "no rules were written" for "the rules could not be read".
 *
 * Quiet on failures: we never block the agent here. If we crash, we
 * exit 0 so the turn proceeds. No self-watchdog is armed: every step is
 * bounded (one config read, one rules read, one locked state write),
 * matching the post-write-reminder sibling in this matcher group, and
 * the host's declared 10 s timeout is the outer bound.
 */

import { writeSync } from "node:fs";

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { detectHookRuntime, isArtifactToolName, type HookRuntime } from "./lib/detect.ts";
import {
  isRealSessionId,
  readSubagentDeliveredIds,
  recordSubagentDeliveredId,
} from "./lib/injection-ledger.ts";
import { renderStandingBlock } from "./lib/standing-block.ts";
import { loadBrainConfig, resolveStandingRulesMaxChars } from "../src/core/brain/policy.ts";
import type { BrainConfig } from "../src/core/brain/types.ts";
import { resolveVault } from "../src/core/config.ts";

/** The one event this hook is registered for; any other emits nothing. */
const CARRIER_EVENT = "PostToolUse";

/**
 * The standing-rules character cap, resolved once per run.
 *
 * The same policy limit the session-start lane applies
 * (`active.standing_rules_max_chars`, documented default on a missing or
 * unreadable `_brain.yaml`). An unreadable config degrades only the CAP
 * here, never the answer: a rules read that then fails still delivers
 * the explicit failure block, so the operator's constitution cannot be
 * mistaken for a missing one.
 */
function resolveStandingRulesCap(vault: string): number {
  let cfg: BrainConfig | null = null;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    // absorbed deliberately - the documented default below
  }
  return resolveStandingRulesMaxChars(cfg);
}

type SubagentInjectOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "PostToolUse";
        readonly additionalContext: string;
      };
    }
  | { readonly decision: "block"; readonly reason: string };

/**
 * The per-runtime output shape: claudecode carries `additionalContext`
 * on the PostToolUse event (the post-write-reminder precedent); every
 * other runtime gets the portable decision shape (the stop-log-guardrail
 * precedent for non-claudecode runtimes).
 */
function subagentInjectOutput(runtime: HookRuntime, block: string): SubagentInjectOutput {
  if (runtime === "claudecode") {
    return { hookSpecificOutput: { hookEventName: CARRIER_EVENT, additionalContext: block } };
  }
  return { decision: "block", reason: block };
}

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  // Only the event this hook is registered for: emitting a context
  // payload under an event whose schema has no channel for it gets the
  // whole line echoed back as a validation error.
  if (payload.hook_event_name !== CARRIER_EVENT) return;

  // A tool call made inside a delegated sub-agent is the one this hook
  // exists for. The host marks it with a non-empty `agent_id` and only
  // there; `agent_type` alone is not a sub-agent marker (the host also
  // sends it on the main thread of a session started with `--agent`).
  // This gate runs before any other work: the main thread pays a field
  // check and nothing else.
  const agentId = payload.agent_id;
  if (typeof agentId !== "string" || agentId.length === 0) return;

  // Write-shaped calls only, belt-and-suspenders: the hooks.json matcher
  // filters most of the rest already.
  if (typeof payload.tool_name !== "string" || !isArtifactToolName(payload.tool_name)) return;

  // The once-per-subagent ledger lives in a per-session scope. Without a
  // real session id there is no scope to dedupe against, so delivery
  // would repeat on every call; silence is the only safe answer.
  if (!isRealSessionId(payload.session_id)) return;

  const vault = resolveVault();
  if (vault === null) return;

  if (readSubagentDeliveredIds(vault, payload.session_id).has(agentId)) return;

  const block = renderStandingBlock(vault, resolveStandingRulesCap(vault));
  // An absent or empty rules file is the steady state, not a failure.
  if (block.length === 0) return;

  // One blocking write to fd 1, not process.stdout.write: a write error
  // must surface HERE, at the emit. Bun and Node deliver stdout errors
  // asynchronously, which would resolve main, run the ledger record
  // below with the delivery still unlanded, and crash with a stderr
  // banner. The synchronous write throws into main's fail-soft catch
  // instead, the id is never recorded, and the next write-shaped call
  // re-delivers - the lose-not-duplicate order made real, not just
  // ordered.
  writeSync(1, `${JSON.stringify(subagentInjectOutput(detectHookRuntime(payload), block))}\n`);

  // Recorded after stdout: a crash or a failed state write in between
  // re-delivers the rules to the next write-shaped call and never
  // leaves a subagent unconstitutioned.
  recordSubagentDeliveredId(vault, payload.session_id, agentId);
}

main().catch(() => {
  // Never block on hook crash.
});
