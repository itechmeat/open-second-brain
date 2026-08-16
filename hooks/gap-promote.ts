#!/usr/bin/env -S bun
/**
 * SessionEnd hook: opt-in knowledge-gap promotion and auto-close (theme A,
 * t_67d38036).
 *
 * When `gap_loop_enabled` is set (default OFF), at session end:
 *   1. every recurring recall gap (from the recall-telemetry gap_counts
 *      aggregate, above a tunable threshold) promotes to ONE durable
 *      gap-task note under the Brain area, deduped on a stable gap key so
 *      re-promotion never collides;
 *   2. every open gap task whose topic now recalls with sufficient
 *      confidence auto-closes (a recorded status flip in frontmatter),
 *      mirroring the dream freshness auto-resolve precedent.
 *
 * Gap-task notes are plain durable files; they never touch the Hermes
 * kanban board. Flag off writes nothing (byte-identical no-op). Fail-open:
 * the hook arms the shared process ceiling and exits 0 on every path; a
 * best-effort audit line records the run's counts, and a run that threw
 * records a `gap_loop_failed` line plus a stderr notice instead of
 * vanishing. SessionEnd cannot carry additionalContext, so this hook never
 * writes stdout.
 */

import {
  defaultConfigPath,
  resolveGapLoopEnabled,
  resolveGapLoopThreshold,
  resolveVault,
} from "../src/core/config.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { hookAuditDir } from "../src/core/brain/paths.ts";
import { gapScopedRecallRetriever } from "../src/core/brain/gaps/gap-recall.ts";
import { autoCloseRecalledGaps, promoteGapsToTasks } from "../src/core/brain/gaps/gap-loop.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

/**
 * The vault this run resolved, remembered for the failure path.
 *
 * A failure is only auditable once the vault is known, and the vault is
 * resolved inside the run - so the failure reporter reads it from here
 * rather than re-resolving (which could itself be the thing that threw).
 */
let auditedVault: string | null = null;

function auditRun(vault: string, details: Record<string, unknown>): void {
  try {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: new Date().toISOString(),
      actor: "gap-promote",
      action: "gap_loop_run",
      target: "SessionEnd",
      ok: true,
      details,
    });
  } catch {
    // best-effort: auditing must never disturb the fail-open contract
  }
}

/**
 * Report a run that threw, on both channels, and never rethrow.
 *
 * Fail-open is about the SESSION, not about the fault: swallowing the
 * throw silently is what let a retriever that ignored its membership rule
 * leave this hook doing nothing at all, run after run, with no trace
 * anywhere - a fallback that quietly does nothing, which this repository
 * does not allow. So the failure lands as its OWN audit action (`ok:
 * false`), never as a `gap_loop_run` row: a run that threw produced no
 * counts, and a counts row with zeros would read as a quiet, healthy
 * no-op - exactly the report this fault already got away with. Stderr
 * carries it too, for the operator who is not reading the audit log.
 *
 * Every step is individually guarded, because this is the last frame
 * before the process exits and there is nothing left to catch it.
 */
function reportRunFailure(exc: unknown): void {
  const kind = exc instanceof Error ? exc.name : typeof exc;
  const message = exc instanceof Error ? exc.message : "";
  try {
    process.stderr.write(`gap-promote: gap loop failed [${kind}] ${message}\n`);
  } catch {
    // a closed stderr must not become the crash the fail-open forbids
  }
  if (auditedVault === null) return;
  try {
    appendAuditRecord(hookAuditDir(auditedVault), {
      timestamp: new Date().toISOString(),
      actor: "gap-promote",
      action: "gap_loop_failed",
      target: "SessionEnd",
      ok: false,
      details: { error: kind, message },
    });
  } catch {
    // best-effort: auditing must never disturb the fail-open contract
  }
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no writes.
  if (!resolveGapLoopEnabled()) return;

  const disarm = armProcessCeiling({ ceilingMs: resolveHookCeilingMs() });
  try {
    try {
      asHookPayload(await readHookInput());
    } catch {
      return;
    }

    const vault = resolveVault();
    if (vault === null) return;
    auditedVault = vault;
    const configPath = defaultConfigPath();
    const now = new Date();
    const threshold = resolveGapLoopThreshold(configPath);

    const promotion = promoteGapsToTasks(vault, {
      now,
      ...(threshold !== undefined ? { threshold } : {}),
    });
    const closure = await autoCloseRecalledGaps(
      vault,
      // NOT `defaultRecallRetriever`: that one takes only the query, and a
      // one-parameter function is structurally assignable here, so it
      // compiled while silently ignoring the membership rule - returning
      // the gap-task note itself and making the gate throw on every run.
      gapScopedRecallRetriever(configPath, vault),
      { now },
    );
    auditRun(vault, {
      promoted: promotion.created.length,
      skipped: promotion.skipped.length,
      // Both bounds the run enforces are reported, never dropped: a pruned
      // count explains a shrinking directory, and a non-zero cap refusal is
      // the operator's only signal that gap tasks are being turned away.
      pruned: promotion.pruned.length,
      capped: promotion.capped,
      closed: closure.closed.length,
      kept: closure.kept.length,
    });
  } finally {
    disarm();
  }
}

main().catch((exc: unknown) => {
  // Never crash the runtime; the session end must proceed regardless -
  // but never fail invisibly either. See `reportRunFailure`.
  reportRunFailure(exc);
});
