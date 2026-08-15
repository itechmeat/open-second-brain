/**
 * The dream pass's per-topic transition decision.
 *
 * One reason to change: what a cluster of active signals on a topic
 * *means*. Everything else about the pass - retire timing, disk writes,
 * log shape - lives elsewhere. Given a scan and the config, this module
 * decides, for each topic with active signals, exactly one of:
 *
 *   - suppress the signals (a user-rejected retired pref covers them),
 *   - quarantine the cluster (self-approval guardrail not satisfied),
 *   - create a new unconfirmed preference,
 *   - note them redundant against the active preference of record,
 *   - accumulate them as a rebuttal (retiring the active pref, or
 *     logging a retain-pinned when it is pinned),
 *   - or record the topic as an unresolved contradiction.
 *
 * Every one of those decisions is per TOPIC, so this module also owns what a
 * topic is for the pass: signals, preferences and retired records are indexed
 * by `topicKey` (the fold), while everything the plan reports keeps a raw
 * spelling from the vault (the display form). Key and label are separate
 * words here on purpose - see `preferredTopicDisplay`.
 *
 * Pure: no I/O, no clock beyond the `now` it is handed.
 */

import { applySelfApprovalGuardrail } from "./trust/self-approval-guardrail.ts";
import {
  emptyPlan,
  filterWithinWindow,
  PREF_ID_PREFIX,
  preferenceSlug,
  recordSignalMove,
  RETIRED_ID_PREFIX,
  topicKey,
  type PlanState,
  type PreferenceRecord,
  type RetiredRecord,
  type ScanResult,
  type SignalRecord,
} from "./dream-plan.ts";
import type { DreamWarning } from "./dream-types.ts";
import { resolveGuardrails } from "./policy.ts";
import { isPinned } from "./pin.ts";
import { countSigns, dominantSignOf } from "./sign.ts";
import { extractTemporalConstraints } from "./temporal-extract.ts";
import { renderPrefLink } from "./wikilink.ts";
import {
  BRAIN_RETIRED_REASON,
  BRAIN_SIGNAL_SIGN,
  type BrainConfig,
  type BrainSignal,
  type BrainSignalSign,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Suffix that keeps a rebuttal's new pref from colliding with the pref it retires. */
const REBUT_SLUG_SUFFIX = "-rebut";

export function planTopics(scan: ScanResult, cfg: BrainConfig, now: Date): PlanState {
  const plan = emptyPlan();
  const reservedSlugs = collectReservedPreferenceSlugs(scan);

  // Group active signals by folded topic key. We only consider active
  // signals for the create/rebut decisions; processed signals stay in the
  // global log via `evidenced_by` already.
  const byTopic = new Map<string, TopicGroup>();
  for (const rec of scan.signals) {
    if (!rec.active) continue;
    const raw = rec.signal.topic;
    const key = topicKey(raw);
    const group = byTopic.get(key);
    if (group) {
      group.sigs.push(rec);
      group.display = preferredTopicDisplay(group.display, raw);
    } else byTopic.set(key, { display: raw, sigs: [rec] });
  }

  // Index existing active preferences by the same key.
  const prefs = indexPreferencesByTopicKey(scan.preferences, plan);

  // Index retired by the same key for supersede and suppression
  // bookkeeping. It has to fold with the rest: the loop below looks these
  // up with the group's key, so leaving this map on raw bytes would make a
  // user-rejected suppressor invisible to the very signals it exists to
  // suppress.
  const retiredByTopic = new Map<string, RetiredRecord[]>();
  for (const r of scan.retired) {
    const key = topicKey(r.topic);
    const arr = retiredByTopic.get(key);
    if (arr) arr.push(r);
    else retiredByTopic.set(key, [r]);
  }

  for (const [key, group] of byTopic) {
    // A contended key has no single rule of record, so there is no answer to
    // "does this signal reinforce or rebut?" - and the wrong answer retires a
    // preference the operator wrote. The pass plans nothing here and says so
    // (`plan.topicKeyContentions` becomes one warning per key on the run
    // summary); the signals stay in inbox/ and are re-evaluated on the next
    // pass, once the vault has one owner for the key.
    if (prefs.contended.has(key)) continue;
    const topic = group.display;
    const sigs = group.sigs;
    const active = prefs.byKey.get(key);
    if (active) {
      handleSignalsOnActivePref(active, sigs, plan, cfg, now, scan.signals, reservedSlugs);
      continue;
    }
    const candidateSigs = applySignalSuppression(topic, sigs, retiredByTopic.get(key), plan);
    if (candidateSigs.length === 0) continue;
    planTopicWithoutActivePref(
      topic,
      key,
      candidateSigs,
      plan,
      cfg,
      now,
      retiredByTopic,
      reservedSlugs,
    );
  }
  return plan;
}

/** Active signals sharing one folded key, plus the spelling that names them. */
interface TopicGroup {
  display: string;
  readonly sigs: SignalRecord[];
}

/**
 * Choose the raw spelling that represents a folded group.
 *
 * The display form is never the folded key: an operator reading the dream
 * report - and the filename of any preference promoted from the group - must
 * see what a signal actually said, not a lowercased, NFC-flattened rendering
 * of it that appears in no file in the vault.
 *
 * The rule is the SMALLEST member in UTF-16 code-unit order, not the first one
 * scanned. `scanBrain` walks `readdirSync` (`dream-scan.ts:35`), which returns
 * entries in whatever order the filesystem stores them, so "first wins" would
 * make the report - and the promoted preference's filename - depend on which
 * machine ran the pass. A total order over the raw strings is a property of
 * the corpus alone, so the same corpus always elects the same representative.
 * Code-unit order rather than `localeCompare` for the same reason the fold
 * itself is structural: the choice must not consult a locale.
 */
function preferredTopicDisplay(a: string, b: string): string {
  return b < a ? b : a;
}

/** The preference index for one pass, plus the keys it refused to index. */
interface PreferenceTopicIndex {
  readonly byKey: Map<string, PreferenceRecord>;
  readonly contended: Set<string>;
}

/**
 * Index active preferences by folded topic key and record every key more than
 * one topic claims.
 *
 * Byte-identical topics keep the historical rule - the first wins, design doc
 * §7.4's "one preference per topic" makes a true duplicate a doctor-level
 * issue rather than a dream concern. What the fold introduces is different: two
 * preferences that were distinct subjects before it now resolve to one key,
 * and the pass has no basis for choosing between them. Those keys are dropped
 * from the index and recorded on the plan, so the ambiguity is reported rather
 * than settled by scan order.
 */
function indexPreferencesByTopicKey(
  preferences: ReadonlyArray<PreferenceRecord>,
  plan: PlanState,
): PreferenceTopicIndex {
  const byKey = new Map<string, PreferenceRecord>();
  const claimants = new Map<string, PreferenceRecord[]>();
  for (const p of preferences) {
    const key = topicKey(p.pref.topic);
    if (!byKey.has(key)) byKey.set(key, p);
    const arr = claimants.get(key);
    if (arr) arr.push(p);
    else claimants.set(key, [p]);
  }

  const contended = new Set<string>();
  for (const [key, records] of claimants) {
    const topics = [...new Set(records.map((r) => r.pref.topic))].toSorted();
    if (topics.length < 2) continue;
    contended.add(key);
    byKey.delete(key);
    plan.topicKeyContentions.push({
      key,
      topics,
      prefIds: records.map((r) => r.pref.id).toSorted(),
    });
  }
  // Sorted for the same reason the representative is chosen by order rather
  // than by arrival: the report must not vary with directory enumeration.
  plan.topicKeyContentions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { byKey, contended };
}

/** Warning code carried by every topic-key contention on a run summary. */
export const TOPIC_KEY_CONTENTION_CODE = "topic-key-contention";

/**
 * Render the plan's topic-key contentions as run-summary warnings.
 *
 * A contention is a standing vault condition, not a mutation, so it does not
 * by itself make a run "changed" - forcing a snapshot and a log write on every
 * pass for a condition only the operator can clear would be churn. The warning
 * rides on BOTH summary shapes (no-op and changed), which is why it is the
 * channel: the CLI prints every warning to stderr and the JSON summary carries
 * it, so a pass that decided nothing for a key still says which key and why.
 */
export function topicKeyContentionWarnings(plan: PlanState): DreamWarning[] {
  return plan.topicKeyContentions.map((c) => ({
    code: TOPIC_KEY_CONTENTION_CODE,
    message:
      `preferences ${c.prefIds.join(", ")} claim one topic key ${JSON.stringify(c.key)} ` +
      `(topics ${c.topics.map((t) => JSON.stringify(t)).join(", ")}). ` +
      `The pass planned nothing for that key; give it one owner by renaming a ` +
      `topic or retiring one of the rules.`,
  }));
}

/**
 * v0.10.1 _summary §6: when a retired pref for this topic carries a
 * `user_rejected_reason`, the user explicitly rejected the rule — re-growing
 * it from fresh signals is exactly what they were asking us not to do.
 * Suppress every matching signal, emit one `signal-suppressed` event per
 * signal pointing at the retired pref + the reason, and move them straight
 * to processed.
 *
 * Per-signal scope match: an unscoped suppressor swallows every signal on
 * the topic; a scoped suppressor only swallows signals sharing its scope (a
 * signal without scope still matches an unscoped suppressor but never a
 * scoped one). Multiple retired prefs on the same topic are tried in order —
 * the first matching suppressor wins. Non-matching signals fall through and
 * remain eligible for candidate-pref planning.
 */
function applySignalSuppression(
  topic: string,
  sigs: SignalRecord[],
  retiredForTopic: RetiredRecord[] | undefined,
  plan: PlanState,
): SignalRecord[] {
  const suppressors = (retiredForTopic ?? []).filter((r) => !!r.user_rejected_reason);
  if (suppressors.length === 0) return sigs;

  const remaining: SignalRecord[] = [];
  for (const sig of sigs) {
    const suppressor = suppressors.find((r) => {
      if (!r.scope) return true;
      if (!sig.signal.scope) return false;
      return r.scope === sig.signal.scope;
    });
    if (!suppressor) {
      remaining.push(sig);
      continue;
    }
    plan.signalsSuppressed.push({
      signal: `[[${sig.signal.id}]]`,
      retired: renderPrefLink({
        id: suppressor.id,
        principle: suppressor.principle,
      }),
      reason: suppressor.user_rejected_reason!,
      topic,
    });
    recordSignalMove(plan, sig);
  }
  return remaining;
}

/**
 * No active pref for this topic → either promote, quarantine, or note a
 * contradiction. `topic` is the group's display spelling (what the plan and
 * the report say); `key` is its folded form (what the maps are indexed by).
 */
function planTopicWithoutActivePref(
  topic: string,
  key: string,
  candidateSigs: SignalRecord[],
  plan: PlanState,
  cfg: BrainConfig,
  now: Date,
  retiredByTopic: Map<string, RetiredRecord[]>,
  reservedSlugs: Set<string>,
): void {
  const windowedSigs = filterWithinWindow(candidateSigs, cfg.dream.contradiction_window_days, now);
  const positives = windowedSigs.filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.positive);
  const negatives = windowedSigs.filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.negative);
  const dominant = positives.length >= negatives.length ? positives : negatives;
  const minoritySize = Math.min(positives.length, negatives.length);
  const dominantSize = dominant.length - minoritySize; // cancellation

  if (dominantSize < cfg.dream.candidate_threshold) {
    if (positives.length > 0 && negatives.length > 0) plan.contradictionTopics.add(topic);
    return;
  }

  if (quarantineIfGuarded(topic, dominant, dominantSize, plan, cfg, now)) return;

  // Decide supersede: if a retired pref for the same topic exists,
  // wire it through.
  const retiredForTopic = retiredByTopic.get(key);
  const supersedesRecord =
    retiredForTopic && retiredForTopic.length > 0 ? retiredForTopic[0]! : undefined;
  const source = dominant[0]!.signal;
  // Slug from topic for the canonical filename, but reserve slugs
  // already present in retired/. Otherwise a superseding preference
  // can be created as `pref-topic` while `ret-topic` already exists;
  // its later retirement would fail trying to overwrite that retired
  // file.
  const slug = allocatePreferencePlanSlug(topic, reservedSlugs);
  // evidencedBy = wikilinks to ALL active signals (dominant + minority)
  // that contributed to this topic in the window. We deliberately
  // include the minority signals so the audit trail preserves the
  // contradiction story even after the file moves to processed/.
  const evidencedBy = windowedSigs.map((s) => `[[${s.signal.id}]]`);
  plan.newUnconfirmed.push({
    slug,
    topic,
    scope: source.scope,
    principle: source.principle,
    evidencedBy,
    sign: source.signal,
    ...deriveSignalTemporal(source, now),
    ...(supersedesRecord
      ? {
          supersedes: renderPrefLink({
            id: supersedesRecord.id,
            principle: supersedesRecord.principle,
          }),
        }
      : {}),
  });
  // Every contributing signal in the window gets moved.
  for (const s of windowedSigs) {
    recordSignalMove(plan, s);
  }
}

/**
 * v0.10.16: extra self-approval guardrail. Defaults (min_signals=2,
 * min_distinct_agents=1, min_age_days=0) make this check a no-op for
 * clusters that already passed `candidate_threshold`. Operators may opt
 * into stricter thresholds via `_brain.yaml:guardrails:*`. A failed gate
 * routes the cluster to `quarantined` instead of creating a new
 * unconfirmed preference; the contributing signals stay in inbox/ so the
 * cluster naturally re-evaluates on the next pass once more evidence
 * accumulates.
 *
 * Returns true when the cluster was quarantined and must not promote.
 */
function quarantineIfGuarded(
  topic: string,
  dominant: ReadonlyArray<SignalRecord>,
  dominantSize: number,
  plan: PlanState,
  cfg: BrainConfig,
  now: Date,
): boolean {
  const distinctAgents = new Set(dominant.map((s) => s.signal.agent)).size;
  let earliestSignalMs = Number.POSITIVE_INFINITY;
  for (const s of dominant) {
    const t = Date.parse(s.signal.created_at);
    if (Number.isFinite(t) && t < earliestSignalMs) earliestSignalMs = t;
  }
  const ageDays = Number.isFinite(earliestSignalMs)
    ? Math.max(0, Math.floor((now.getTime() - earliestSignalMs) / DAY_MS))
    : 0;
  const verdict = applySelfApprovalGuardrail(
    {
      signal_count: dominantSize,
      distinct_agents: distinctAgents,
      age_days: ageDays,
    },
    resolveGuardrails(cfg),
  );
  if (verdict.decision !== "quarantine") return false;
  plan.quarantined.push({
    topic,
    signal_count: dominantSize,
    distinct_agents: distinctAgents,
    age_days: ageDays,
    failed_gates: verdict.failed_gates,
  });
  return true;
}

/**
 * Determine the active preference's sign. Order of preference:
 *
 *   1. Walk `evidenced_by` wikilinks and look up each referenced
 *      signal in the global scan; the dominant sign among them is
 *      the pref's "sign of record". This is the design-correct
 *      derivation since the writer baked those evidence pointers in.
 *
 *   2. If no `evidenced_by` resolves (e.g. a hand-crafted pref or a
 *      pref whose source signals were manually pruned), look at all
 *      historical signals on the same topic in the global scan.
 *
 *   3. If still nothing, assume the active pref is on the OPPOSITE
 *      sign of the incoming dominant sign. This makes a unanimous
 *      flood of new signals always count as rebuttal — which is the
 *      conservative, fail-loud choice: the operator gets a clear
 *      rebut/retire signal and can manually intervene if the system
 *      misread their intent.
 */
function deriveActiveSign(
  active: PreferenceRecord,
  sigs: SignalRecord[],
  allSignals: ReadonlyArray<SignalRecord>,
): BrainSignalSign {
  const signCounts = (records: ReadonlyArray<SignalRecord>): { pos: number; neg: number } =>
    countSigns(records.map((r) => r.signal.signal));

  // Tier-1 derivation now lives in the shared `sign.ts` helper so the
  // semantic-health contradiction detector and this pass agree on one
  // definition. `dominantSignOf` returning a concrete sign is exactly
  // the old `evidenceRecords.length > 0` branch (every signal carries a
  // polarity, so a resolved evidence link always counts); `"unknown"`
  // is the old "no evidenced signal resolved" fall-through.
  const signSignById = new Map(allSignals.map((r) => [r.signal.id, r.signal.signal]));
  const evidenceSign = dominantSignOf(active.pref.evidenced_by, signSignById);
  if (evidenceSign !== "unknown") return evidenceSign;

  // Folded, like every other topic comparison in this pass: a historical
  // signal spelled differently from the preference it evidences is still a
  // signal on the preference's subject.
  const activeKey = topicKey(active.pref.topic);
  const topicRecords = allSignals.filter((r) => topicKey(r.signal.topic) === activeKey);
  if (topicRecords.length > sigs.length) {
    // There are processed signals for this topic that are NOT among
    // the active inbox set — use them.
    const c = signCounts(topicRecords.filter((r) => !sigs.includes(r)));
    return c.pos >= c.neg ? BRAIN_SIGNAL_SIGN.positive : BRAIN_SIGNAL_SIGN.negative;
  }
  // Fallback: assume the active pref is OPPOSITE to the incoming
  // dominant sign. A unanimous flood thus reads as rebuttal.
  const c = signCounts(sigs);
  return c.pos > c.neg ? BRAIN_SIGNAL_SIGN.negative : BRAIN_SIGNAL_SIGN.positive;
}

function handleSignalsOnActivePref(
  active: PreferenceRecord,
  sigs: SignalRecord[],
  plan: PlanState,
  cfg: BrainConfig,
  now: Date,
  allSignals: ReadonlyArray<SignalRecord>,
  reservedSlugs: Set<string>,
): void {
  const activeSign = deriveActiveSign(active, sigs, allSignals);
  const oppositeSign: BrainSignalSign =
    activeSign === BRAIN_SIGNAL_SIGN.positive
      ? BRAIN_SIGNAL_SIGN.negative
      : BRAIN_SIGNAL_SIGN.positive;

  const windowed = filterWithinWindow(sigs, cfg.dream.contradiction_window_days, now);
  const sameSign = windowed.filter((s) => s.signal.signal === activeSign);
  const opposing = windowed.filter((s) => s.signal.signal === oppositeSign);

  const activeLink = renderPrefLink({
    id: active.pref.id,
    principle: active.pref.principle,
  });

  // Same-sign → note redundant + move to processed.
  for (const s of sameSign) {
    plan.notedRedundant.push({
      preference: activeLink,
      signal: `[[${s.signal.id}]]`,
    });
    recordSignalMove(plan, s);
  }

  // Opposite-sign → accumulate toward rebuttal.
  if (opposing.length < cfg.dream.candidate_threshold) {
    if (opposing.length > 0) plan.contradictionTopics.add(active.pref.topic);
    return;
  }

  if (isPinned(active.pref)) {
    plan.retainPinned.push({
      preference: activeLink,
      reason: BRAIN_RETIRED_REASON.rebutted,
    });
    // Rebuttal signals on a pinned pref still get moved out — they
    // were addressed (the system saw them) and clogging the inbox
    // doesn't help.
    for (const s of opposing) recordSignalMove(plan, s);
    return;
  }

  const slug = preferenceSlug(active.pref.id);
  plan.retires.push({
    slug,
    principle: active.pref.principle,
    reason: BRAIN_RETIRED_REASON.rebutted,
  });
  for (const s of opposing) recordSignalMove(plan, s);
  // Create a new unconfirmed pref for the new direction.
  // Build a fresh slug to avoid filename collision with the
  // retiring pref (which lives under preferences/<slug>.md and
  // will move to retired/<slug>.md). The simplest scheme: the
  // same slug, since `moveToRetired` unlinks the source first.
  // For safety against a half-completed move, we suffix with
  // `-rebut`.
  const source = opposing[0]!.signal;
  plan.newUnconfirmed.push({
    slug: allocatePreferencePlanSlug(`${slug}${REBUT_SLUG_SUFFIX}`, reservedSlugs),
    topic: active.pref.topic,
    scope: source.scope,
    principle: source.principle,
    evidencedBy: opposing.map((s) => `[[${s.signal.id}]]`),
    sign: oppositeSign,
    ...deriveSignalTemporal(source, now),
    supersedes: activeLink,
  });
}

function collectReservedPreferenceSlugs(scan: ScanResult): Set<string> {
  const out = new Set<string>();
  for (const p of scan.preferences) {
    const slug = strictSlugFromId(p.pref.id, PREF_ID_PREFIX);
    if (slug) out.add(slug);
  }
  for (const r of scan.retired) {
    const slug = strictSlugFromId(r.id, RETIRED_ID_PREFIX);
    if (slug) out.add(slug);
  }
  return out;
}

/**
 * Strict counterpart to `preferenceSlug`: an id that does not carry the
 * expected prefix reserves nothing, because it names no file the writer
 * would ever produce.
 */
function strictSlugFromId(id: string, prefix: string): string | null {
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
}

function allocatePreferencePlanSlug(base: string, reserved: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  reserved.add(candidate);
  return candidate;
}

/**
 * Brain lifecycle suite (F5). Derive a preference's bi-temporal validity
 * from the source signal: prefer the signal's explicit `valid_from` /
 * `valid_until`, otherwise extract formal ISO temporal tokens from the
 * signal's principle + raw text. Returns `{}` when neither yields a
 * constraint, so callers spread it without changing byte output.
 */
function deriveSignalTemporal(
  sig: BrainSignal,
  now: Date,
): { valid_from?: string; valid_until?: string } {
  if (sig.valid_from || sig.valid_until) {
    return {
      ...(sig.valid_from ? { valid_from: sig.valid_from } : {}),
      ...(sig.valid_until ? { valid_until: sig.valid_until } : {}),
    };
  }
  const text = `${sig.principle ?? ""}\n${sig.raw ?? ""}`;
  return extractTemporalConstraints(text, { now });
}
