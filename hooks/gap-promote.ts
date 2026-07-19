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
 * best-effort audit line records the run's counts. SessionEnd cannot carry
 * additionalContext, so this hook never writes stdout.
 */

import { join } from "node:path";

import {
  defaultConfigPath,
  resolveGapLoopEnabled,
  resolveGapLoopThreshold,
  resolveVault,
} from "../src/core/config.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { defaultRecallRetriever } from "../src/core/brain/recall-inject.ts";
import { autoCloseRecalledGaps, promoteGapsToTasks } from "../src/core/brain/gaps/gap-loop.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

function auditRun(vault: string, details: Record<string, unknown>): void {
  try {
    appendAuditRecord(join(vault, ".open-second-brain", "hook-audit"), {
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
    const configPath = defaultConfigPath();
    const now = new Date();
    const threshold = resolveGapLoopThreshold(configPath);

    const promotion = promoteGapsToTasks(vault, {
      now,
      ...(threshold !== undefined ? { threshold } : {}),
    });
    const closure = await autoCloseRecalledGaps(vault, defaultRecallRetriever(configPath, vault), {
      now,
    });
    auditRun(vault, {
      promoted: promotion.created.length,
      skipped: promotion.skipped.length,
      closed: closure.closed.length,
      kept: closure.kept.length,
    });
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the session end must proceed regardless.
});
