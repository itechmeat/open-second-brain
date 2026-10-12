#!/usr/bin/env -S bun
/**
 * SubagentStart / PostToolUse hook: delivers the operator's context
 * payload into a delegated sub-agent (context-injection-pipeline).
 *
 * The session-start digest never reaches a sub-agent: SessionStart fires
 * once for the main thread, while the agent that performs the actual
 * writes can be exactly the one running without the operator's context.
 *
 * Two channels, one ledger:
 *
 *   - SubagentStart (primary) fires when the host spawns the sub-agent,
 *     before its first prompt, so the payload is in place from the first
 *     turn; the host re-injects the context if the sub-agent compacts.
 *     No tool gating: the event itself marks a sub-agent start.
 *   - PostToolUse (fallback) keeps this carrier working on runtimes
 *     without the SubagentStart event. It fires on the sub-agent's
 *     write-shaped tool calls - the moments learned rules govern - and
 *     stays silent for read-only subagents.
 *
 * The fallback feeds the once-per-sub-agent ledger, so on a host with
 * both events the write-shaped calls of an already-served sub-agent
 * stay silent. The primary channel never consults that ledger: the
 * host re-fires SubagentStart when a sub-agent compacts, and the
 * post-compaction context exists only if this hook answers that later
 * event.
 *
 * Payload (composed by hooks/lib/active-context.ts, the same assembly
 * the session-start lane uses): the operator's standing rules first,
 * then the scoped operator rules for this project and this device, then
 * the budgeted active context - runtime notices, the rendered
 * Brain/active.md body, lessons - under the same
 * `active.inject_budget_chars` ceiling, whose tier ladder degrades
 * oversized sections. Absence and failure stay different answers: a
 * rules read that FAILED delivers the explicit failure block naming the
 * path, because a subagent must never mistake "no rules were written"
 * for "the rules could not be read"; a memory assembly that throws
 * degrades the memory lane to empty and never takes the rules lanes
 * down with it.
 *
 * Contract (identical for every runtime):
 *   stdin: hook payload JSON with `hook_event_name`, the host-assigned
 *     `agent_id` that marks a sub-agent, and - on the PostToolUse
 *     fallback only - `tool_name` / `tool_input`.
 *   stdout: nothing, or one line with the payload:
 *     { "hookSpecificOutput": { "hookEventName": "SubagentStart" |
 *                                           "PostToolUse",
 *                               "additionalContext": "<payload>" } }
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
 * The delivered agent ids live in the per-session hook-state ledger
 * (`osb.subagent_inject.delivered`, capped, 24 h TTL); the fallback
 * consults it before emitting, the primary channel does not. Each record
 * also names the vault-relative note paths the delivered payload was
 * built from, so the answer-time quote check (answer-trust wave) can
 * verify that sub-agent's quoted spans against the evidence it actually
 * had. The id is recorded AFTER the stdout write on both channels -
 * lose-not-duplicate, like every carrier in this tree - so a crash
 * between write and record re-delivers rather than losing the payload.
 *
 * Silent on every empty-handed path, exit 0: no non-empty `agent_id`
 * (the main thread is served by active-inject), on PostToolUse a tool
 * outside the write set, no real session id (the ledger needs a session
 * scope; a sessionless host would re-deliver on every call), no vault,
 * or an entirely empty payload - no standing rules, no scoped rules,
 * no learned context (the steady state is an operator whose vault says
 * nothing yet).
 *
 * Quiet on failures: we never block the agent here. If we crash, we
 * exit 0 so the turn proceeds. No self-watchdog is armed: every step is
 * bounded (one config read, a handful of file reads, one locked state
 * write), matching the post-write-reminder sibling in the fallback's
 * matcher group, and the host's declared 10 s timeout is the outer
 * bound.
 */

import { writeSync } from "node:fs";
import { posix } from "node:path";

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isArtifactToolName } from "./lib/detect.ts";
import {
  isRealSessionId,
  readSubagentDeliveredIds,
  recordSubagentDeliveredId,
  type SubagentEvidencePath,
} from "./lib/injection-ledger.ts";
import { renderStandingBlock } from "./lib/standing-block.ts";
import {
  SOURCE_ACTIVE_BODY,
  SOURCE_LESSONS_BODY,
  assembleActiveContext,
  createInjectionMeter,
  joinBlocks,
  renderScopedBlock,
  resolveInjectionLimits,
  scopedSectionCap,
} from "./lib/active-context.ts";
import {
  BRAIN_ACTIVE_FILE,
  BRAIN_LESSONS_FILE,
  BRAIN_ROOT_REL,
  BRAIN_STANDING_RULES_FILE,
} from "../src/core/brain/path-constants.ts";
import { readScopedRules } from "../src/core/brain/scoped-rules.ts";
import { resolveHostScope, resolveProjectScope } from "../src/core/brain/scope-identity.ts";
import { readStandingRules } from "../src/core/brain/standing-rules.ts";
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

/**
 * The carrier's payload plus the note evidence it was built from. The
 * evidence paths feed the delivery ledger so the answer-time quote check
 * can verify this sub-agent's quoted spans against the notes the payload
 * actually carried (answer-trust wave).
 */
interface CarrierPayload {
  readonly block: string;
  /**
   * Vault-relative note paths whose content the payload carries. A
   * truncated delivery - the payload carries only the note's prefix -
   * records `{ path, truncated: true }`, so the quote check judges
   * spans against the delivered prefix, never the whole file.
   */
  readonly evidencePaths: ReadonlyArray<SubagentEvidencePath>;
}

/**
 * The vault-relative standing-rules path, when a real read fed the
 * block. An absent or empty file renders no block at all, and a read
 * that FAILED renders the explicit failure block - the payload then
 * carries a notice ABOUT the file, not the file's content, so neither
 * case is delivered evidence. A read that hit the character cap
 * delivered a prefix: the entry is marked truncated so a quote of the
 * undelivered tail reads `source-truncated`, never silence.
 */
function standingEvidencePaths(
  vault: string,
  maxChars: number,
): ReadonlyArray<SubagentEvidencePath> {
  try {
    const rules = readStandingRules(vault, { maxChars });
    if (rules === null) return [];
    const path = posix.join(BRAIN_ROOT_REL, BRAIN_STANDING_RULES_FILE);
    return rules.truncated ? [{ path, truncated: true }] : [path];
  } catch {
    return [];
  }
}

/**
 * The vault-relative scoped-rule file paths this session's scope
 * matched. The identity mirrors `renderScopedBlock`'s so the reported
 * paths and the delivered block cannot disagree; the harness axis is
 * always null on this surface (both injection lanes are shared by Claude
 * Code and Codex through one `o2b-hook` shim and have no harness signal).
 */
function scopedEvidencePaths(
  vault: string,
  workspaceDir: string,
  maxChars: number,
): ReadonlyArray<string> {
  try {
    let host: { readonly host: string | null; readonly unreadable: boolean };
    try {
      host = resolveHostScope(undefined);
    } catch {
      host = { host: null, unreadable: true };
    }
    return readScopedRules(
      vault,
      { project: resolveProjectScope(workspaceDir, vault), harness: null, host: host.host },
      { maxChars, hostUnreadable: host.unreadable },
    ).files.map((file) => file.path);
  } catch {
    return [];
  }
}

/**
 * Compose the carrier's payload: the same three lanes, joined the same
 * way, as the session-start preamble. The meter exists because the
 * assembly records its sub-bodies there - the memory note paths are read
 * back off it (a rendered `Brain/active.md` or `Brain/lessons.md` body is
 * delivered evidence), while the rules lanes report their consumed paths
 * directly. Runtime notices are generated state, not a note.
 */
function composeCarrierPayload(vault: string, workspaceDir: string): CarrierPayload {
  const limits = resolveInjectionLimits(vault);
  const meter = createInjectionMeter(limits.injectBudgetChars);
  const standingBlock = renderStandingBlock(vault, limits.standingRulesMaxChars, meter);
  const sectionCap = scopedSectionCap(limits);
  const scopedBlock = renderScopedBlock(vault, workspaceDir, sectionCap, meter);
  const memoryBudget = Math.max(0, limits.injectBudgetChars - scopedBlock.length);
  // No last-good cache on this surface: a genuine read error inside the
  // assembly degrades the memory lane to empty rather than emitting a
  // partial or poisoned payload, and the rules lanes above it survive.
  let memoryContext = "";
  try {
    memoryContext = assembleActiveContext(vault, memoryBudget, meter);
  } catch {
    memoryContext = "";
  }
  const emitted = (name: string): boolean => meter.sources.some((s) => s.name === name);
  return {
    block: joinBlocks([standingBlock, scopedBlock, memoryContext]),
    evidencePaths: [
      ...standingEvidencePaths(vault, limits.standingRulesMaxChars),
      ...scopedEvidencePaths(vault, workspaceDir, sectionCap),
      ...(emitted(SOURCE_ACTIVE_BODY) ? [posix.join(BRAIN_ROOT_REL, BRAIN_ACTIVE_FILE)] : []),
      ...(emitted(SOURCE_LESSONS_BODY) ? [posix.join(BRAIN_ROOT_REL, BRAIN_LESSONS_FILE)] : []),
    ],
  };
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

  // The ledger suppresses only the fallback: PostToolUse fires on every
  // write-shaped call, so a recorded id there means this sub-agent
  // already has its payload. SubagentStart skips the read on purpose -
  // the host re-fires it after a compaction, and Claude Code re-injects
  // the post-compaction context only if the hook returns it on that
  // later event; a ledger hit here would leave a compacted sub-agent
  // with nothing.
  if (
    event === FALLBACK_EVENT &&
    readSubagentDeliveredIds(vault, payload.session_id).has(agentId)
  ) {
    return;
  }

  // The scoped rules key off the session's project: the payload `cwd`
  // when the host sent one, else this process's (the session-start lane
  // resolves the same field the same way).
  const workspaceDir =
    typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const carrier = composeCarrierPayload(vault, workspaceDir);
  // Silent only when the ENTIRE payload is empty: an absent rules file is
  // no longer silence on a vault whose operator has learned preferences.
  if (carrier.block.length === 0) return;

  // One blocking write to fd 1, not process.stdout.write: a write error
  // must surface HERE, at the emit. Bun and Node deliver stdout errors
  // asynchronously, which would resolve main, run the ledger record
  // below with the delivery still unlanded, and crash with a stderr
  // banner. The synchronous write throws into main's fail-soft catch
  // instead, the id is never recorded, and the next carrier event for
  // this sub-agent re-delivers - the lose-not-duplicate order made real,
  // not just ordered.
  writeSync(1, `${JSON.stringify(subagentInjectOutput(event, carrier.block))}\n`);

  // Recorded after stdout on both channels: a crash or a failed state
  // write in between re-delivers the payload on the next carrier event,
  // and on the primary channel the record is what keeps the PostToolUse
  // fallback silent once this sub-agent's payload has landed. The record
  // names the note paths the payload was built from, so the answer-time
  // quote check can verify this sub-agent's quoted spans against the
  // evidence it actually had.
  recordSubagentDeliveredId(vault, payload.session_id, agentId, carrier.evidencePaths);
}

main().catch(() => {
  // Never block on hook crash.
});
