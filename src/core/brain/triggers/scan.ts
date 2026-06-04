/**
 * Trigger scan (Workspace Insight Suite, t_cd1fee79): one explicit
 * pull that runs the existing report generators, normalizes their
 * findings through the adapters, and persists deduped triggers.
 */

import { runDoctor } from "../doctor.ts";
import { buildRetentionReview } from "../retention.ts";
import { collisionCandidates, detectAgentCollisions } from "../truth/collision.ts";
import { readClaimEvents } from "../truth/store.ts";
import { candidatesFromHealth, candidatesFromRetention } from "./adapters.ts";
import { createTriggers, type CreateTriggersOptions, type CreateTriggersResult } from "./store.ts";
import type { InsightCandidate } from "./types.ts";

export interface ScanTriggersOptions extends CreateTriggersOptions {
  /** Extra candidates from other producers (synthesis, ideas). */
  readonly extraCandidates?: ReadonlyArray<InsightCandidate>;
}

export interface ScanTriggersResult extends CreateTriggersResult {
  readonly candidates: number;
}

/**
 * Generate trigger candidates from semantic health and retention data,
 * then persist them with cooldown dedup. Fail-soft per source: a
 * report that cannot run contributes nothing rather than aborting the
 * scan.
 */
export function scanTriggers(vault: string, opts: ScanTriggersOptions): ScanTriggersResult {
  const candidates: InsightCandidate[] = [];
  try {
    const doctor = runDoctor(vault);
    if (doctor.semantic_health !== undefined) {
      candidates.push(...candidatesFromHealth(doctor.semantic_health));
    }
  } catch {
    // semantic health unavailable - skip the source
  }
  try {
    candidates.push(...candidatesFromRetention(buildRetentionReview(vault, { now: opts.now })));
  } catch {
    // retention review unavailable - skip the source
  }
  try {
    // Cross-agent collisions (t_f2b225b1): an empty ledger detects
    // nothing, so vaults without claim events stay byte-identical.
    const { events } = readClaimEvents(vault);
    if (events.length > 0) {
      candidates.push(...collisionCandidates(detectAgentCollisions(events, { now: opts.now })));
    }
  } catch {
    // claim ledger unavailable - skip the source
  }
  candidates.push(...(opts.extraCandidates ?? []));

  const result = createTriggers(vault, candidates, opts);
  return Object.freeze({ ...result, candidates: candidates.length });
}
