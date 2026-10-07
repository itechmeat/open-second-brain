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
 *     structured audit line (counts, scores, classification - never the
 *     prompt text or recalled content) to the LOCAL hook-audit trail, and
 *     one recall-telemetry record onto the synced continuity log. The two
 *     are deliberately not the same payload: only the local line may carry
 *     a retriever's own message (see `recordDecision`).
 *   - FAIL-OPEN FOR THE SESSION: the hook process never blocks the user. It
 *     arms a self-watchdog ceiling and exits 0 on every path.
 *   - SESSION-AWARE: with a real `session_id` and `recall_inject_dedupe`
 *     (default on), notes this session was already shown - by an earlier
 *     brief or by the SessionStart digest - are not injected again. The
 *     injection ledger is read before the decision and written only after
 *     the stdout write, and a failed write is named on the audit line.
 *     Without a session id no ledger is touched.
 *   - TUNABLE: the four caps resolve from config and env; an invalid value
 *     keeps the built-in constant and is named on the audit line.
 *   - SLICED: a `recall_inject:` block in `Brain/_brain.yaml` declares named
 *     slices, retrieved under the one budget and rendered as headed groups
 *     inside the one fence. A `_brain.yaml` that fails to load also fails
 *     the search that reads it: an `error` decision with fault
 *     `retriever_failed`, and `slices_config: "invalid"` on the audit line.
 *   - OPTIONAL DECISION-MODEL FILTER: with the `recall_inject` use in
 *     `shadow` or `enforce` (default `off`), an `inject` decision is checked
 *     by one decision request within `decision_model_hook_budget_ms` and
 *     what is left of the retrieval budget. It can only drop notes or
 *     withhold the brief; any failure keeps the decision unchanged.
 *
 * Contract mirrors active-inject.ts: stdin is the hook payload JSON; the
 * vault is resolved from the persisted config, not the payload; stdout, when
 * present, is the standard `hookSpecificOutput.additionalContext` envelope.
 */

import {
  defaultConfigPath,
  discoverConfig,
  resolveRecallInjectCaps,
  resolveRecallInjectDedupe,
  resolveRecallInjectEnabled,
  resolveTokenImpactLedgerEnabled,
  resolveVault,
} from "../src/core/config.ts";
import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
} from "../src/core/decision-model/config.ts";
import { emitTokenImpact, TOKEN_COUNT_METHOD } from "../src/core/brain/token-impact.ts";
import { decisionTokenImpactSource } from "../src/core/decision-model/contract.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { emitGatedTelemetry } from "../src/core/brain/continuity/emit.ts";
import { existsSync } from "node:fs";

import { brainConfigPath, hookAuditDir } from "../src/core/brain/paths.ts";
import { loadBrainConfig } from "../src/core/brain/policy/load.ts";
import type { RecallSliceSpec } from "../src/core/brain/types.ts";
import {
  decideRecallInject,
  defaultRecallRetriever,
  RECALL_INJECT_FAULT,
  recallInjectNoteKey,
  recallInjectAuditDetails,
  recallInjectTelemetryMetadata,
  type RecallInjectDecision,
  type RecallInjectFilter,
  type RecallRetriever,
} from "../src/core/brain/recall-inject.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
  RECALL_TELEMETRY_MODE,
  RECALL_TELEMETRY_STATUS,
  type RecallTelemetryStatus,
} from "../src/core/brain/recall-telemetry.ts";
import {
  isRealSessionId,
  readActiveEmittedPaths,
  readRecallInjected,
  recordRecallInjected,
} from "./lib/injection-ledger.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { isHookStateCorrupt } from "./lib/session-state.ts";
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
function recordDecision(
  vault: string,
  decision: RecallInjectDecision,
  hookDetails: Readonly<Record<string, unknown>> = {},
): void {
  auditDecision(vault, decision, hookDetails);
  emitGatedTelemetry(true, () =>
    emitRecallTelemetry(vault, {
      host: HOOK_TELEMETRY_HOST,
      channel: RECALL_CHANNEL.hook,
      // The hook's retriever IS a search; nothing finer is claimed here.
      mode: RECALL_TELEMETRY_MODE.search,
      status: telemetryStatus(decision),
      durationMs: 0,
      resultCount: decision.kind === "inject" ? decision.noteCount : 0,
      // Classifications and counts only. The two surfaces are NOT the
      // same payload: this one is a continuity record that syncs and that
      // `brain_recall_telemetry` returns verbatim to a model, so it takes
      // the withholding projection while the local audit line below takes
      // the one that still carries the retriever's own message.
      metadata: recallInjectTelemetryMetadata(decision),
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
 * One audit line per decision. Never throws (a hung filesystem is exactly
 * when this runs) and never records the prompt text or recalled content -
 * only the decision kind, its classification, and bounded counts/scores.
 *
 * This line, unlike the telemetry record above, MAY carry the retriever's
 * own message: the audit trail is local, unsynced operational evidence
 * under `<vault>/.open-second-brain/hook-audit/`, and a SQLite or config
 * message is precisely what an operator debugging a broken retriever
 * needs. The withholding happens on the other surface, not here.
 *
 * `hookDetails` carries what only the hook knows (rejected config keys,
 * the sizes of the dedupe sets it consulted, a failed ledger record); an
 * empty object leaves the line as it was.
 */
function auditDecision(
  vault: string,
  decision: RecallInjectDecision,
  hookDetails: Readonly<Record<string, unknown>>,
): void {
  try {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: new Date().toISOString(),
      actor: HOOK_TELEMETRY_HOST,
      action: "recall_inject_decision",
      target: "UserPromptSubmit",
      ok: decision.kind === "inject",
      details: { ...recallInjectAuditDetails(decision), ...hookDetails },
    });
  } catch {
    // best-effort: auditing must never disturb the fail-open contract
  }
}

/**
 * The optional decision-model filter (issue #213, Part 9), or undefined
 * when the `recall_inject` use is `off`, the feature is not active, or the
 * config cannot be read. Undefined leaves the decision exactly as before:
 * no module loaded, no request, no record, no extra field.
 */
async function decisionFilterFor(
  configPath: string,
  vault: string,
): Promise<RecallInjectFilter | undefined> {
  try {
    const cfg = resolveDecisionModelConfig({ config: discoverConfig(configPath).data, vault });
    if (decisionModelModeFor(cfg, "recall_inject") === "off") return undefined;
    const { createRecallInjectDecisionFilter } =
      await import("../src/core/brain/recall-inject-decision.ts");
    return createRecallInjectDecisionFilter({ config: cfg, vault }) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host-side saving of an enforced filter, as a `token_impact` sample
 * (gated by `token_impact_ledger_enabled`, fail-open). Counts only.
 */
function recordTokenImpact(
  vault: string,
  configPath: string,
  decision: RecallInjectDecision,
): void {
  if (decision.kind === "error") return;
  const info = decision.decisionModel;
  if (info === undefined || info.tokensBefore === undefined || info.tokensAfter === undefined) {
    return;
  }
  if (info.charsRemoved <= 0) return;
  try {
    emitTokenImpact(
      vault,
      {
        host: HOOK_TELEMETRY_HOST,
        source: decisionTokenImpactSource("recall_inject"),
        baselineTokens: info.tokensBefore,
        packedTokens: info.tokensAfter,
        method: TOKEN_COUNT_METHOD.heuristic,
      },
      resolveTokenImpactLedgerEnabled(configPath) || undefined,
    );
  } catch {
    // best-effort, like every other telemetry write here
  }
}

/** What this session was already shown, for the dedupe filter. */
interface DeliveredSets {
  readonly alreadyInjected: ReadonlySet<string>;
  readonly activeDigestPaths: ReadonlySet<string>;
}

/**
 * The session's ledger sets (null when dedupe does not apply: no real session
 * id, `recall_inject_dedupe` off, or a read that threw) and how the read
 * degraded. Fail-open: a broken ledger means repeats, never a lost brief, and
 * `ledgerRead` names it so the audit line does not pass it off as a fresh
 * session (`corrupt`) or as dedupe being off (`failed`).
 */
function deliveredSetsFor(
  vault: string,
  configPath: string,
  sessionId: string | null,
): { readonly sets: DeliveredSets | null; readonly ledgerRead: "corrupt" | "failed" | null } {
  if (sessionId === null) return { sets: null, ledgerRead: null };
  try {
    if (!resolveRecallInjectDedupe(configPath)) return { sets: null, ledgerRead: null };
    return {
      sets: {
        alreadyInjected: readRecallInjected(vault, sessionId),
        activeDigestPaths: readActiveEmittedPaths(vault, sessionId),
      },
      ledgerRead: isHookStateCorrupt(vault, sessionId) ? "corrupt" : null,
    };
  } catch {
    return { sets: null, ledgerRead: "failed" };
  }
}

/**
 * The vault's declared recall slices. A vault without `_brain.yaml` has
 * none and says nothing; one whose `_brain.yaml` fails to load is reported
 * as `invalid` so the audit line can say why the decision failed.
 */
function slicesFor(vault: string): {
  readonly slices: ReadonlyArray<RecallSliceSpec>;
  readonly invalid: boolean;
} {
  try {
    if (!existsSync(brainConfigPath(vault))) return { slices: [], invalid: false };
    return { slices: loadBrainConfig(vault).recall_inject?.slices ?? [], invalid: false };
  } catch {
    return { slices: [], invalid: true };
  }
}

/** The default retriever narrowed to one slice's path prefix and types. */
function sliceRetrieverFor(
  configPath: string,
  vault: string,
): (slice: RecallSliceSpec, limit: number) => RecallRetriever {
  return (slice, limit) =>
    defaultRecallRetriever(configPath, vault, {
      limit,
      ...(slice.pathPrefix !== null ? { pathPrefix: slice.pathPrefix } : {}),
      types: slice.types,
    });
}

/**
 * Record the rendered notes after the brief reached stdout; best-effort.
 * Returns `false` when the ledger could not be written.
 */
function recordInjected(
  vault: string,
  sessionId: string,
  decision: Extract<RecallInjectDecision, { kind: "inject" }>,
): boolean {
  try {
    return recordRecallInjected(vault, sessionId, decision.injectedNotes.map(recallInjectNoteKey));
  } catch {
    // best-effort: a missed record costs one repeat, never the session
    return false;
  }
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
        recordDecision(auditVault, {
          kind: "error",
          fault: RECALL_INJECT_FAULT.hookCeilingExceeded,
        });
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

    const sessionId = isRealSessionId(payload.session_id) ? payload.session_id : null;
    const { caps, invalid } = resolveRecallInjectCaps(configPath);
    const { sets: delivered, ledgerRead } = deliveredSetsFor(vault, configPath, sessionId);
    const sliceConfig = slicesFor(vault);

    const decisionFilter = await decisionFilterFor(configPath, vault);
    const decision = await decideRecallInject(
      prompt,
      defaultRecallRetriever(configPath, vault, caps.maxNotes),
      {
        ...caps,
        ...(decisionFilter !== undefined ? { decisionFilter } : {}),
        ...(sliceConfig.slices.length > 0
          ? {
              slices: sliceConfig.slices,
              sliceRetriever: sliceRetrieverFor(configPath, vault),
            }
          : {}),
        ...delivered,
      },
    );
    const hookDetails = {
      ...(invalid.length > 0 ? { config_invalid: invalid } : {}),
      ...(sliceConfig.invalid ? { slices_config: "invalid" } : {}),
      ...(delivered !== null
        ? {
            dedupe_sets: {
              already_injected: delivered.alreadyInjected.size,
              digest_paths: delivered.activeDigestPaths.size,
            },
          }
        : {}),
      ...(ledgerRead !== null ? { ledger_read: ledgerRead } : {}),
    };
    recordTokenImpact(vault, configPath, decision);
    if (decision.kind !== "inject") {
      recordDecision(vault, decision, hookDetails);
      return;
    }

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: decision.brief,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    // Audited after the record, so a ledger that cannot be written (and so
    // will repeat these notes) leaves evidence on the same line.
    const recorded =
      delivered === null || sessionId === null || recordInjected(vault, sessionId, decision);
    recordDecision(
      vault,
      decision,
      recorded ? hookDetails : { ...hookDetails, ledger_recorded: false },
    );
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the prompt submission must proceed regardless
  // of any hook misbehaviour.
});
