/**
 * Per-skill invocation telemetry (t_56a12bde) and the offer join (t_ccb05134).
 *
 * How often each installed skill is actually invoked by an agent runtime is a
 * usage signal distinct from proposing, ranking, or verifying skills. Each
 * invocation is captured as an append-only `skill_invoked` continuity record
 * (emitted by the session-import tool-call scan across Claude Code / opencode
 * logs). Counts are DERIVED read-side here - a replayable aggregation, never a
 * mutated counter - mirroring the working-memory usage-signal shape, so the
 * dream / synthesis pass can rank, retain, or retire skills on real evidence.
 * Deterministic; no LLM.
 *
 * An invocation that cites the offer it came from carries that offer's id
 * (see `../surface/skill-offer.ts`), which closes the link the efficacy chain
 * was missing: {@link joinSkillInvocationsToOffers} groups invocations under
 * the offer that produced them. An invocation citing no offer is reported
 * separately and is never attributed to one by proximity or by guesswork -
 * "we do not know which offer this came from" is a different answer from
 * "this came from that offer", and the two are not collapsed.
 */

import { loadNormalizedContinuityRecords } from "./continuity/read-model.ts";
import { decayWeight } from "./continuity/usage-signal.ts";
import { readSkillOfferId } from "../surface/skill-offer.ts";

export interface SkillUsage {
  readonly skill: string;
  /** How many times the skill was invoked across all captured runtimes. */
  readonly invocationCount: number;
  /**
   * How many of those invocations cited the offer they came from. The
   * remainder are not unattributed-by-error: most runtimes' skill calls are
   * not preceded by an offer at all.
   */
  readonly offerAttributedCount: number;
  /** Most recent invocation time, epoch ms, or null when never dated. */
  readonly lastInvokedAtMs: number | null;
  /** Recency/frequency decay weight in (0, 1], for ranking. */
  readonly weight: number;
}

/** One `skill_invoked` record, normalised to the fields the join needs. */
export interface SkillInvocation {
  /** Content-addressed continuity record id. */
  readonly recordId: string;
  readonly skill: string;
  /** Offer this invocation cited, or null when it cited none. */
  readonly offerId: string | null;
  readonly invokedAtMs: number | null;
}

export interface SkillOfferJoin {
  readonly offerId: string;
  /** Invocations citing this offer, in record order. */
  readonly invocations: ReadonlyArray<SkillInvocation>;
}

export interface SkillOfferJoinReport {
  /** Offers with at least one invocation, by offer id ascending. */
  readonly offers: ReadonlyArray<SkillOfferJoin>;
  /** Invocations citing no offer. Never folded into an offer above. */
  readonly unattributed: ReadonlyArray<SkillInvocation>;
}

interface MutableUsage {
  count: number;
  attributed: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

/**
 * Every `skill_invoked` record in the vault, deduplicated and normalised.
 *
 * Continuity logs are append-only with no write-time dedup, so a re-imported
 * session re-appends byte-identical records. Their content-addressed id
 * (kind + createdAt + sourceRefs + payload) is stable, so keying on DISTINCT
 * ids makes every derivation below idempotent across re-imports. A record
 * carrying no usable skill name is not an invocation and is skipped.
 */
function readSkillInvocations(vault: string): SkillInvocation[] {
  const records = loadNormalizedContinuityRecords(vault, { kind: "skill_invoked" });
  const seen = new Set<string>();
  const out: SkillInvocation[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const skill = typeof record.payload["skill"] === "string" ? record.payload["skill"] : null;
    if (skill === null || skill.length === 0) continue;
    const atMs = Date.parse(record.createdAt);
    out.push({
      recordId: record.id,
      skill,
      offerId: readSkillOfferId(record.payload),
      invokedAtMs: Number.isFinite(atMs) ? atMs : null,
    });
  }
  return out;
}

/**
 * Derive per-skill invocation counts from `skill_invoked` continuity records.
 * Ranked by count descending, then skill name ascending for stable output.
 */
export function deriveSkillUsage(vault: string, opts: { nowMs?: number } = {}): SkillUsage[] {
  const bySkill = new Map<string, MutableUsage>();

  for (const invocation of readSkillInvocations(vault)) {
    const entry = bySkill.get(invocation.skill) ?? {
      count: 0,
      attributed: 0,
      firstAtMs: null,
      lastAtMs: null,
    };
    entry.count += 1;
    if (invocation.offerId !== null) entry.attributed += 1;
    const dated = invocation.invokedAtMs;
    if (dated !== null) {
      entry.firstAtMs = entry.firstAtMs === null ? dated : Math.min(entry.firstAtMs, dated);
      entry.lastAtMs = entry.lastAtMs === null ? dated : Math.max(entry.lastAtMs, dated);
    }
    bySkill.set(invocation.skill, entry);
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
      offerAttributedCount: entry.attributed,
      lastInvokedAtMs: entry.lastAtMs,
      weight,
    });
  }

  usage.sort((a, b) => b.invocationCount - a.invocationCount || a.skill.localeCompare(b.skill));
  return usage;
}

/**
 * Join invocations back to the offers that produced them.
 *
 * The join key is the offer id an invocation cited - the acting agent's
 * claim about where the invocation came from, which is checkable (a
 * malformed id was never stamped, and a real offer id can be recomputed from
 * the offer) but is not an authenticated one; nothing in this system has
 * credentials to authenticate it with, and no surface describes it as more
 * than it is.
 */
export function joinSkillInvocationsToOffers(vault: string): SkillOfferJoinReport {
  const byOffer = new Map<string, SkillInvocation[]>();
  const unattributed: SkillInvocation[] = [];

  for (const invocation of readSkillInvocations(vault)) {
    if (invocation.offerId === null) {
      unattributed.push(invocation);
      continue;
    }
    const group = byOffer.get(invocation.offerId);
    if (group === undefined) byOffer.set(invocation.offerId, [invocation]);
    else group.push(invocation);
  }

  const offers = [...byOffer.entries()]
    .map(([offerId, invocations]) =>
      Object.freeze({ offerId, invocations: Object.freeze(invocations) }),
    )
    .toSorted((a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0));

  return Object.freeze({
    offers: Object.freeze(offers),
    unattributed: Object.freeze(unattributed),
  });
}
