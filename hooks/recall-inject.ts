#!/usr/bin/env -S bun
/**
 * UserPromptSubmit hook: opt-in, bounded, fail-closed, audited prompt-time
 * recall (theme A, t_2ce46130).
 *
 * When `recall_inject_enabled` is set (default OFF), each user prompt
 * relevance-recalls a small bounded brief of vault notes and injects it as
 * `additionalContext`. Every guarantee is deliberate:
 *   - OPT-IN: the flag is checked first; unset means an immediate no-op with
 *     zero output, keeping the prompt preamble byte-identical.
 *   - BOUNDED: the decision core caps notes, characters, and wall-clock time
 *     (named constants in recall-inject.ts); it adds no new retriever, reusing
 *     the existing cross-vault search and recall-hint primitives.
 *   - FAIL-CLOSED: any internal error or timeout injects nothing. The
 *     decision is never a silent fallback - abstain/error is an explicit,
 *     recorded outcome.
 *   - AUDITED: every decision (inject, abstain, error) writes exactly one
 *     structured, payload-safe audit line (counts, scores, reason - never the
 *     prompt text or recalled content).
 *   - FAIL-OPEN FOR THE SESSION: the hook process never blocks the user. It
 *     arms a self-watchdog ceiling and exits 0 on every path.
 *
 * Contract mirrors active-inject.ts: stdin is the hook payload JSON; the
 * vault is resolved from the persisted config, not the payload; stdout, when
 * present, is the standard `hookSpecificOutput.additionalContext` envelope.
 */

import { defaultConfigPath, resolveRecallInjectEnabled, resolveVault } from "../src/core/config.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { emitGatedTelemetry } from "../src/core/brain/continuity/emit.ts";
import { hookAuditDir } from "../src/core/brain/paths.ts";
import {
  decideRecallInject,
  defaultRecallRetriever,
  type RecallInjectDecision,
} from "../src/core/brain/recall-inject.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
  RECALL_TELEMETRY_MODE,
  RECALL_TELEMETRY_STATUS,
  type RecallTelemetryStatus,
} from "../src/core/brain/recall-telemetry.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";

/**
 * Record one decision on both surfaces: the hook audit trail, and the
 * recall-telemetry channel.
 *
 * The audit line alone made the `hook` channel empty by construction, so
 * the doctor's coverage check could only ever answer "unknown" for the
 * one channel operators complain about. Both writes are best-effort and
 * neither can disturb the fail-open contract: the audit has its own
 * try/catch, and the telemetry goes through the shared gated emitter,
 * which swallows a throwing continuity write exactly as every other
 * telemetry site does.
 */
function recordDecision(vault: string, decision: RecallInjectDecision): void {
  auditDecision(vault, decision);
  emitGatedTelemetry(true, () =>
    emitRecallTelemetry(vault, {
      host: HOOK_TELEMETRY_HOST,
      channel: RECALL_CHANNEL.hook,
      // The hook's retriever IS a search; nothing finer is claimed here.
      mode: RECALL_TELEMETRY_MODE.search,
      status: telemetryStatus(decision),
      durationMs: 0,
      resultCount: decision.kind === "inject" ? decision.noteCount : 0,
      metadata: auditDetails(decision),
    }),
  );
}

/** Runtime identity on the record; the transport is `channel`, not this. */
const HOOK_TELEMETRY_HOST = "recall-inject";

/**
 * The hook's three decisions onto the telemetry status vocabulary.
 *
 * `abstain` maps to `empty` rather than to nothing at all: the hook ran
 * and decided not to inject, and that is precisely the signal that
 * separates a quiet hook from an absent one. Emitting nothing for an
 * abstain would destroy the evidence this unit exists to produce.
 */
function telemetryStatus(decision: RecallInjectDecision): RecallTelemetryStatus {
  switch (decision.kind) {
    case "inject":
      return RECALL_TELEMETRY_STATUS.ok;
    case "abstain":
      return RECALL_TELEMETRY_STATUS.empty;
    case "error":
      return RECALL_TELEMETRY_STATUS.error;
  }
}

/**
 * One payload-safe audit line per decision. Never throws (a hung filesystem
 * is exactly when this runs) and never records the prompt text or recalled
 * content - only the decision kind, reason, and bounded counts/scores.
 */
function auditDecision(vault: string, decision: RecallInjectDecision): void {
  try {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: new Date().toISOString(),
      actor: HOOK_TELEMETRY_HOST,
      action: "recall_inject_decision",
      target: "UserPromptSubmit",
      ok: decision.kind === "inject",
      details: auditDetails(decision),
    });
  } catch {
    // best-effort: auditing must never disturb the fail-open contract
  }
}

function auditDetails(decision: RecallInjectDecision): Record<string, unknown> {
  if (decision.kind === "inject") {
    return { decision: "inject", note_count: decision.noteCount, top_score: decision.topScore };
  }
  if (decision.kind === "abstain") {
    return { decision: "abstain", reason: decision.reason, top_score: decision.topScore };
  }
  return { decision: "error", reason: decision.reason };
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no process
  // ceiling armed, no payload read, no output - byte-identical to before.
  if (!resolveRecallInjectEnabled()) return;

  let auditVault: string | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    onExpire: () => {
      if (auditVault !== null) {
        recordDecision(auditVault, { kind: "error", reason: "hook_ceiling_exceeded" });
      }
    },
  });
  try {
    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }

    const hookEventName =
      typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
        ? payload.hook_event_name
        : "UserPromptSubmit";
    // Default-closed: only an additionalContext-eligible event may emit.
    if (!isContextEventName(hookEventName)) return;

    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

    const vault = resolveVault();
    if (vault === null) return;
    auditVault = vault;
    const configPath = defaultConfigPath();

    const decision = await decideRecallInject(prompt, defaultRecallRetriever(configPath, vault));
    recordDecision(vault, decision);
    if (decision.kind !== "inject") return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: decision.brief,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the prompt submission must proceed regardless
  // of any hook misbehaviour.
});
