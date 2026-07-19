#!/usr/bin/env -S bun
/**
 * PreToolUse hook: opt-in strict read-block orientation gate
 * (retrieval-quality-and-context-delivery, D2 / t_36b0fd8d).
 *
 * With `hook_strict_enabled` on (default OFF), the FIRST raw vault-file read of
 * a session is denied once - via Claude Code's `permissionDecision: "deny"` -
 * with a redirect to the brain search surface, after which the hook downgrades
 * to a soft nudge (an explicit `permissionDecision: "allow"` carrying a
 * reminder) for the rest of the session. Any brain query/search refreshes a
 * short-lived "recently oriented" stamp that suppresses the block.
 *
 * Guarantees:
 *   - OPT-IN: the flag is checked FIRST; unset means an immediate no-op with
 *     zero output, so every tool call stays byte-identical to today.
 *   - STRUCTURAL: the raw-read decision (see decideOrient) keys on the file
 *     path resolving inside the configured vault root, never on loose tool-name
 *     or message-text matching.
 *   - FAIL-OPEN EVERYWHERE: a missing/unreadable payload, an unresolvable
 *     vault, a missing/malformed/expired stamp, and a non-Claude-Code harness
 *     all resolve to "allow" (emit nothing). Fail-open is an explicit decision,
 *     not a swallowed error. The wrapper additionally forces exit 0.
 *   - AUDITED: each meaningful decision (deny / nudge / orientation refresh)
 *     writes one payload-safe audit line; a plain allow is silent to avoid one
 *     record per tool call.
 */

import { join } from "node:path";

import { resolveHookStrictEnabled, resolveVault } from "../src/core/config.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { decideOrient, type OrientDecision } from "../src/core/brain/pretool-orient.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { detectHookRuntime } from "./lib/detect.ts";
import { readHookStamp, writeHookStamp } from "./lib/session-state.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

/** Namespaced stamps (binding D2 convention). */
const ORIENTED_RECENT_KEY = "osb.oriented.recent";
const ORIENTED_BLOCKED_KEY = "osb.oriented.blocked";

/** "Recently oriented" window: a brain search suppresses the block this long. */
const ORIENT_RECENT_TTL_MS = 30 * 60_000;
/** The one-time block downgrades to a nudge for the rest of the session. */
const ORIENT_BLOCKED_TTL_MS = 24 * 60 * 60_000;

const PRE_TOOL_USE_EVENT = "PreToolUse";

function auditDecision(vault: string, toolName: string, decision: OrientDecision): void {
  // A plain allow is the overwhelming majority of tool calls; skip it so the
  // audit log records only the meaningful strict-mode decisions.
  if (decision.kind === "allow") return;
  try {
    appendAuditRecord(join(vault, ".open-second-brain", "hook-audit"), {
      timestamp: new Date().toISOString(),
      actor: "pretool-orient",
      action: "orient_decision",
      target: PRE_TOOL_USE_EVENT,
      ok: decision.kind !== "deny",
      details: { decision: decision.kind, tool: toolName },
    });
  } catch {
    // best-effort: auditing must never disturb the fail-open contract
  }
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no process
  // ceiling armed, no payload read, no output - byte-identical to before.
  if (!resolveHookStrictEnabled()) return;

  const disarm = armProcessCeiling({ ceilingMs: resolveHookCeilingMs() });
  try {
    let raw: unknown;
    try {
      raw = await readHookInput();
    } catch {
      return; // unreadable payload -> fail open
    }
    const payload = asHookPayload(raw);
    const runtime = detectHookRuntime(raw);

    const vault = resolveVault();
    if (vault === null) return; // no vault root to compare against -> fail open

    const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";

    const nowMs = Date.now();
    const isOriented = readHookStamp(vault, sessionId, ORIENTED_RECENT_KEY, nowMs) !== null;
    const alreadyBlocked = readHookStamp(vault, sessionId, ORIENTED_BLOCKED_KEY, nowMs) !== null;

    const decision = decideOrient({
      runtime,
      toolName,
      toolInput: payload.tool_input,
      vaultRoot: vault,
      isOriented,
      alreadyBlocked,
    });
    auditDecision(vault, toolName, decision);

    if (decision.kind === "refresh_orientation") {
      writeHookStamp(vault, sessionId, ORIENTED_RECENT_KEY, {
        expiresAt: nowMs + ORIENT_RECENT_TTL_MS,
      });
      return;
    }
    if (decision.kind === "deny") {
      // Stamp the one-time block closed BEFORE emitting so the next raw read is
      // a nudge, not a second deny, even if this process dies mid-write.
      writeHookStamp(vault, sessionId, ORIENTED_BLOCKED_KEY, {
        expiresAt: nowMs + ORIENT_BLOCKED_TTL_MS,
      });
      emitPermission("deny", decision.reason);
      return;
    }
    if (decision.kind === "nudge") {
      emitPermission("allow", decision.reason);
      return;
    }
    // allow: emit nothing, tool proceeds through the normal permission flow.
  } finally {
    disarm();
  }
}

function emitPermission(permissionDecision: "deny" | "allow", reason: string): void {
  const out = {
    hookSpecificOutput: {
      hookEventName: PRE_TOOL_USE_EVENT,
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch(() => {
  // Never crash the runtime; the tool call must proceed regardless of any hook
  // misbehaviour (fail open).
});
