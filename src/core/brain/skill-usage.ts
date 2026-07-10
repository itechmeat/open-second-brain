/**
 * Per-skill invocation telemetry (t_56a12bde).
 *
 * How often each installed skill is actually invoked by an agent runtime is a
 * usage signal distinct from proposing, ranking, or verifying skills. Each
 * invocation is captured as an append-only `skill_invoked` continuity record
 * (emitted by the session-import tool-call scan across Claude Code / opencode
 * logs). Counts are DERIVED read-side here - a replayable aggregation, never a
 * mutated counter - mirroring the working-memory usage-signal shape, so the
 * dream / synthesis pass can rank, retain, or retire skills on real evidence.
 * Deterministic; no LLM.
 */

import { loadNormalizedContinuityRecords } from "./continuity/read-model.ts";
import { decayWeight } from "./continuity/usage-signal.ts";

export interface SkillUsage {
  readonly skill: string;
  /** How many times the skill was invoked across all captured runtimes. */
  readonly invocationCount: number;
  /** Most recent invocation time, epoch ms, or null when never dated. */
  readonly lastInvokedAtMs: number | null;
  /** Recency/frequency decay weight in (0, 1], for ranking. */
  readonly weight: number;
}

interface MutableUsage {
  count: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

/**
 * Derive per-skill invocation counts from `skill_invoked` continuity records.
 * Ranked by count descending, then skill name ascending for stable output.
 */
export function deriveSkillUsage(vault: string, opts: { nowMs?: number } = {}): SkillUsage[] {
  const records = loadNormalizedContinuityRecords(vault, { kind: "skill_invoked" });
  const bySkill = new Map<string, MutableUsage>();
  // Continuity logs are append-only with no write-time dedup, so a re-imported
  // session re-appends byte-identical records. Their content-addressed id
  // (kind + createdAt + sourceRefs + payload) is stable, so counting DISTINCT
  // ids makes the derivation idempotent across re-imports.
  const seen = new Set<string>();

  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const skill = typeof record.payload["skill"] === "string" ? record.payload["skill"] : null;
    if (skill === null || skill.length === 0) continue;
    const atMs = Date.parse(record.createdAt);
    const dated = Number.isFinite(atMs) ? atMs : null;
    const entry = bySkill.get(skill) ?? { count: 0, firstAtMs: null, lastAtMs: null };
    entry.count += 1;
    if (dated !== null) {
      entry.firstAtMs = entry.firstAtMs === null ? dated : Math.min(entry.firstAtMs, dated);
      entry.lastAtMs = entry.lastAtMs === null ? dated : Math.max(entry.lastAtMs, dated);
    }
    bySkill.set(skill, entry);
  }

  const nowMs = opts.nowMs ?? Date.now();
  const usage: SkillUsage[] = [];
  for (const [skill, entry] of bySkill) {
    // Decay from the creation baseline with the invocation count as the
    // frequency signal, reusing the shared working-memory decay curve.
    const weight = decayWeight(
      {
        createdAtMs: entry.firstAtMs ?? nowMs,
        accessCount: entry.count,
        lastAccessAtMs: entry.lastAtMs,
      },
      nowMs,
    );
    usage.push({
      skill,
      invocationCount: entry.count,
      lastInvokedAtMs: entry.lastAtMs,
      weight,
    });
  }

  usage.sort((a, b) => b.invocationCount - a.invocationCount || a.skill.localeCompare(b.skill));
  return usage;
}
