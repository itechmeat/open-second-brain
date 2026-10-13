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
import { clamp01 } from "../math.ts";
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
 * Join derived usage rows onto the discovered skill names, for ranking.
 *
 * The usage store keys on the raw invocation string (`payload["skill"]`),
 * which is runtime-dependent: an MCP `get_skill` name equals the discovered
 * `SkillEntry.name` byte for byte, while a Claude Code `Skill` command
 * arrives plugin-qualified (`open-second-brain:codegraph-partner`) and never
 * equals it. The join rule, deterministic and vocabulary-free:
 *
 *   - a usage key that IS a known name joins exactly, and an exact join
 *     always wins over an inferred one;
 *   - any other key joins the longest suffix after a colon that is a known
 *     name (for `a:b:c`, `b:c` before `c`);
 *   - a key matching nothing is dropped - unknown is unknown, never
 *     guessed onto a nearest-looking name;
 *   - when several rows join the same known name, the higher weight wins,
 *     so the result never depends on row order.
 *
 * Pure: the inputs are not mutated and the values are the decay weights
 * unchanged, so an empty usage list yields an empty map.
 */
export function skillUsageWeights(
  usage: ReadonlyArray<SkillUsage>,
  knownNames: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const weights = new Map<string, number>();
  for (const [name, rows] of joinUsageRows(usage, knownNames)) {
    for (const row of rows) {
      if ((weights.get(name) ?? 0) < row.weight) weights.set(name, row.weight);
    }
  }
  return weights;
}

/**
 * Tunables for {@link skillUsageRankingWeights}. The defaults mirror the
 * shared decay curve's (`decayWeight`, `./continuity/usage-signal.ts`):
 * the recency half of the ranking weight is the same curve, so the only
 * thing the ranking builder changes is how frequency enters.
 */
export interface SkillUsageRankingOptions {
  /** Injected clock, epoch ms. Default `Date.now()`. */
  readonly nowMs?: number;
  /** Exponential half-life of the recency decay, in days. Default 30. */
  readonly halfLifeDays?: number;
  /** Lower clamp so a weight never reads as zero. Default 0.02. */
  readonly minWeight?: number;
}

const DAY_MS = 86_400_000;
const RANKING_HALF_LIFE_DAYS = 30;
const RANKING_MIN_WEIGHT = 0.02;

/**
 * Join usage rows onto the discovered names with a ranking weight that does
 * not saturate (the t_5d1ec8a8 follow-up to review finding M5).
 *
 * Why not {@link skillUsageWeights}: its values are the decay weights, and
 * that weight is frequency multiplied into an age decay and then CLAMPED at
 * 1 - a skill invoked once within the last few days and one invoked three
 * hundred times this week both clamp, tie, and let the name tie-break
 * decide, so among recently used skills the ordering sees recency only.
 * This builder keeps the clamp out of the frequency term:
 *
 *   weight = recency(row) * log1p(count) / log1p(maxCount)
 *
 * where `recency(row)` is the shared curve's age half - `0.5 ** (ageDays /
 * halfLifeDays)` measured from the row's last dated invocation, or 1 when
 * the row carries no date at all (the same creation-baseline convention the
 * decay curve applies) - and `maxCount` is the largest invocation count
 * among the rows that JOIN a known name, so an unjoined heavy row can never
 * shrink the joined ones. The ratio is 1 for the most-invoked joined row
 * and falls off logarithmically below it; when every joined count is 1 it
 * is 1 everywhere and the map is pure recency, so normalisation only
 * separates, never inverts. The result is clamped to
 * `[minWeight, 1]` - bounded like the decay weight, but the cap is now
 * reachable only at full recency, not at one recent invocation.
 *
 * Same join rule, purity contract and order-independence as
 * {@link skillUsageWeights} (several rows on one name: the strongest
 * normalised weight wins); no I/O, and the clock enters only through the
 * `nowMs` option, so a pinned input always yields the same map.
 */
export function skillUsageRankingWeights(
  usage: ReadonlyArray<SkillUsage>,
  knownNames: ReadonlySet<string>,
  opts: SkillUsageRankingOptions = {},
): ReadonlyMap<string, number> {
  const weights = new Map<string, number>();
  const joined = joinUsageRows(usage, knownNames);
  if (joined.size === 0) return weights;
  const nowMs = opts.nowMs ?? Date.now();
  const halfLifeMs = Math.max(1, (opts.halfLifeDays ?? RANKING_HALF_LIFE_DAYS) * DAY_MS);
  const minWeight = clamp01(opts.minWeight ?? RANKING_MIN_WEIGHT);
  let maxCount = 1;
  for (const rows of joined.values()) {
    for (const row of rows) maxCount = Math.max(maxCount, row.invocationCount);
  }
  const maxLog = Math.log1p(maxCount);
  for (const [name, rows] of joined) {
    let best = 0;
    for (const row of rows) {
      const frequency = Math.log1p(Math.max(0, row.invocationCount)) / maxLog;
      best = Math.max(best, recencyFactor(row, nowMs, halfLifeMs) * frequency);
    }
    weights.set(name, Math.min(1, Math.max(minWeight, best)));
  }
  return weights;
}

/**
 * The age half of the shared decay curve for one usage row. Kept beside the
 * join rather than read back off `SkillUsage.weight` because that export is
 * the saturated value - the clamp this builder exists to bypass is baked
 * into it, and the frequency term is not invertible through a clamp.
 */
function recencyFactor(row: SkillUsage, nowMs: number, halfLifeMs: number): number {
  if (row.lastInvokedAtMs === null) return 1;
  const ageMs = Math.max(0, nowMs - row.lastInvokedAtMs);
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * Group usage rows by the known name each joins, exact joins before
 * inferred ones. The shared join rule behind both weight builders; rows
 * keep their input order inside a group, and a name with an exact join
 * never receives a suffix row, so neither builder's result can depend on
 * row order (their per-name reduction is a max).
 */
function joinUsageRows(
  usage: ReadonlyArray<SkillUsage>,
  knownNames: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlyArray<SkillUsage>> {
  const exact = new Set<string>();
  const joined = new Map<string, SkillUsage[]>();
  for (const row of usage) {
    if (!knownNames.has(row.skill)) continue;
    exact.add(row.skill);
    const group = joined.get(row.skill);
    if (group === undefined) joined.set(row.skill, [row]);
    else group.push(row);
  }
  for (const row of usage) {
    if (knownNames.has(row.skill)) continue;
    const suffix = suffixKnownName(row.skill, knownNames);
    if (suffix === null || exact.has(suffix)) continue;
    const group = joined.get(suffix);
    if (group === undefined) joined.set(suffix, [row]);
    else group.push(row);
  }
  return joined;
}

/** Longest suffix of `key` after a colon that is a known name, or null. */
function suffixKnownName(key: string, knownNames: ReadonlySet<string>): string | null {
  for (let i = key.indexOf(":"); i !== -1; i = key.indexOf(":", i + 1)) {
    // Suffixes shrink as the colon index advances, so the first hit is the
    // longest match.
    const suffix = key.slice(i + 1);
    if (knownNames.has(suffix)) return suffix;
  }
  return null;
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
