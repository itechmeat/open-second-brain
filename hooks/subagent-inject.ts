#!/usr/bin/env -S bun
/**
 * SubagentStart / PostToolUse hook: delivers the operator's
 * standing-rules block into a delegated sub-agent
 * (context-injection-pipeline).
 *
 * The session-start digest never reaches a sub-agent: SessionStart fires
 * once for the main thread, while the agent that performs the actual
 * writes can be exactly the one running without the operator's rules.
 *
 * Two channels, one ledger:
 *
 *   - SubagentStart (primary) fires when the host spawns the sub-agent,
 *     before its first prompt, so the rules are in place from the first
 *     turn; the host re-injects the context if the sub-agent compacts.
 *     No tool gating: the event itself marks a sub-agent start.
 *   - PostToolUse (fallback) keeps this carrier working on runtimes
 *     without the SubagentStart event. It fires on the sub-agent's
 *     write-shaped tool calls - the moments learned rules govern - and
 *     stays silent for read-only subagents.
 *
 * Both channels feed the same once-per-sub-agent ledger, so on a host
 * with both events only the first one to fire delivers.
 *
 * Contract (identical for every runtime):
 *   stdin: hook payload JSON with `hook_event_name`, the host-assigned
 *     `agent_id` that marks a sub-agent, and - on the PostToolUse
 *     fallback only - `tool_name` / `tool_input`.
 *   stdout: nothing, or one line naming the operator's standing rules:
 *     { "hookSpecificOutput": { "hookEventName": "SubagentStart" |
 *                                           "PostToolUse",
 *                               "additionalContext": "<block>" } }
 *     the envelope must name the event it rode in on - a host validates
 *     hook output against a per-event schema, so a SubagentStart
 *     delivery under the PostToolUse name (or the reverse) is rejected
 *     and echoed back as a validation error. A `decision: "block"` is
 *     never a context channel on either event: on PostToolUse the tool
 *     result already exists, so a block is rejection feedback about that
 *     result (Codex marks the hook Blocked), not additive context. The
 *     output helper is local to this file so hooks/lib/messages.ts
 *     stays untouched.
 *
 * Exactly once per sub-agent: the delivered agent ids live in the
 * per-session hook-state ledger (`osb.subagent_inject.delivered`, capped,
 * 24 h TTL). The id is recorded AFTER the stdout write - lose-not-
 * duplicate, like every carrier in this tree - so a second call with the
 * same id is silent and a crash between write and record re-delivers
 * rather than losing the rules.
 *
 * Silent on every empty-handed path, exit 0: no non-empty `agent_id`
 * (the main thread is served by active-inject), on PostToolUse a tool
 * outside the write set, no real session id (the ledger needs a session
 * scope; a sessionless host would re-deliver on every call), no vault,
 * an absent or empty rules file (the steady state is an operator who
 * wrote no rules). A rules read that FAILED is not silent: it delivers
 * the explicit failure block naming the path, because a subagent must
 * never mistake "no rules were written" for "the rules could not be
 * read".
 *
 * Quiet on failures: we never block the agent here. If we crash, we
 * exit 0 so the turn proceeds. No self-watchdog is armed: every step is
 * bounded (one config read, one rules read, one locked state write),
 * matching the post-write-reminder sibling in the fallback's matcher
 * group, and the host's declared 10 s timeout is the outer bound.
 */

import { writeSync } from "node:fs";

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isArtifactToolName } from "./lib/detect.ts";
import {
  isRealSessionId,
  readSubagentDeliveredIds,
  recordSubagentDeliveredId,
} from "./lib/injection-ledger.ts";
import { renderStandingBlock } from "./lib/standing-block.ts";
import { loadBrainConfig, resolveStandingRulesMaxChars } from "../src/core/brain/policy.ts";
import type { BrainConfig } from "../src/core/brain/types.ts";
import { resolveVault } from "../src/core/config.ts";

/**
 * The primary channel: registered in hooks/hooks.json for SubagentStart,
 * which the host fires when the Task tool spawns a sub-agent. Any other
 * event emits nothing.
 */
const START_EVENT = "SubagentStart";

/**
 * The fallback channel for runtimes without SubagentStart: registered
 * for PostToolUse inside the write-shaped matcher group, next to the
 * post-write-reminder sibling that proves the additionalContext channel
 * is injected developer-side on this event.
 */
const FALLBACK_EVENT = "PostToolUse";

type CarrierEvent = typeof START_EVENT | typeof FALLBACK_EVENT;

function isCarrierEvent(name: unknown): name is CarrierEvent {
  return name === START_EVENT || name === FALLBACK_EVENT;
}

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

type SubagentInjectOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: CarrierEvent;
    readonly additionalContext: string;
  };
};

/**
 * The output shape for every runtime: the `additionalContext` envelope
 * naming the delivery event, runtime-agnostic like the post-write-
 * reminder sibling that ships the PostToolUse form to Claude Code, Codex
 * and Grok alike. A `decision: "block"` is never a context channel on
 * these events - on PostToolUse it flags the completed write as
 * rejected - so the Stop guardrail's portable shape stays Stop-only.
 */
function subagentInjectOutput(event: CarrierEvent, block: string): SubagentInjectOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: block } };
}

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  // Only the events this hook is registered for: emitting a context
  // payload under an event whose schema has no channel for it gets the
  // whole line echoed back as a validation error.
  const event = payload.hook_event_name;
  if (!isCarrierEvent(event)) return;

  // A payload marked with a non-empty `agent_id` is the one this hook
  // exists for. The host assigns it inside a delegated sub-agent and only
  // there; `agent_type` alone is not a sub-agent marker (the host also
  // sends it on the main thread of a session started with `--agent`).
  // This gate runs before any other work: the main thread pays a field
  // check and nothing else.
  const agentId = payload.agent_id;
  if (typeof agentId !== "string" || agentId.length === 0) return;

  // Fallback-only gating, belt-and-suspenders: the hooks.json matcher
  // filters most of the rest already, and SubagentStart needs no tool
  // gate at all - the event itself is the sub-agent marker.
  if (event === FALLBACK_EVENT) {
    if (typeof payload.tool_name !== "string" || !isArtifactToolName(payload.tool_name)) return;
  }

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
  // instead, the id is never recorded, and the next carrier event for
  // this sub-agent re-delivers - the lose-not-duplicate order made real,
  // not just ordered.
  writeSync(1, `${JSON.stringify(subagentInjectOutput(event, block))}\n`);

  // Recorded after stdout: a crash or a failed state write in between
  // re-delivers the rules on the next carrier event and never leaves a
  // subagent unconstitutioned.
  recordSubagentDeliveredId(vault, payload.session_id, agentId);
}

main().catch(() => {
  // Never block on hook crash.
});
