/**
 * Hygiene of the rule set itself (§11).
 *
 * Every check here reads the preference snapshot and asks the same kind
 * of question: is this rule still earning its place? Near-duplicates,
 * confirmations no use ever backed, pins nothing keeps warm, and stored
 * hashes the live text no longer produces.
 */

import { verifyContentHash } from "../content-hash.ts";
import { topicKey } from "../dream-plan.ts";
import { findSimilarPairs, tokenise } from "../similarity.ts";
import { BRAIN_PREFERENCE_STATUS } from "../types.ts";
import type { DoctorCheck } from "./check.ts";

const JACCARD_DUPLICATE_THRESHOLD = 0.7;

/** Milliseconds in a day, for the two age cutoffs below. */
const DAY_MS = 24 * 3600 * 1000;

/**
 * `duplicate-preferences`: pairwise jaccard similarity of `principle`
 * tokens within each `(topic, scope)` bucket of confirmed/quarantine
 * prefs. Pairs with similarity ≥ `JACCARD_DUPLICATE_THRESHOLD` are
 * flagged. Unconfirmed and retired prefs are excluded — they're
 * meant to be replaced or already are.
 */
export const duplicatePreferenceCheck: DoctorCheck = {
  failSoft: true,
  run({ config, preferences }, { issues }) {
    if (config === undefined) return;
    const entries = [];
    for (const { pref } of preferences) {
      if (
        pref.status !== BRAIN_PREFERENCE_STATUS.confirmed &&
        pref.status !== BRAIN_PREFERENCE_STATUS.quarantine
      )
        continue;
      entries.push({
        id: pref.id,
        // Same-scope-undefined falls in its own bucket. Mirrors the
        // §12 merge-candidate detector exactly — both surfaces stay
        // in sync via the shared walker.
        bucketKey: `${pref.topic}\x00${pref.scope ?? ""}`,
        tokens: tokenise(pref.principle),
        source: pref,
      });
    }
    const pairs = findSimilarPairs(entries, { threshold: JACCARD_DUPLICATE_THRESHOLD });
    for (const pair of pairs) {
      const a = pair.a.source;
      issues.push({
        severity: "warning",
        code: "duplicate-preferences",
        message:
          `[[${pair.a.id}]] and [[${pair.b.id}]] in topic '${a.topic}'` +
          `${a.scope ? ` (scope: ${a.scope})` : ""}` +
          ` look like duplicates (jaccard ${pair.jaccard.toFixed(2)} of principle tokens).` +
          " Consider merging.",
      });
    }
  },
};

/** Issue code for two topic spellings that resolve to one dream-pass key. */
const TOPIC_KEY_COLLISION_CODE = "topic-key-collision";

/**
 * `topic-key-collision`: two or more preferences whose topics differ as
 * bytes but fold onto one `topicKey`.
 *
 * The dream pass already detects this and warns - and then plans NOTHING
 * for the key, because "one preference per topic" can no longer decide
 * which rule a signal on it bears on. Its warning tells the operator to give
 * the key one owner by renaming a topic or retiring a rule, and until this
 * check existed there was no way to go and find the pair: every doctor
 * surface compared raw topic bytes, so the one condition the warning is
 * about was the one condition the doctor could not see. A warning whose
 * remedy has no tool behind it is a dead end.
 *
 * The check uses `topicKey` itself rather than a second copy of the rule, so
 * the doctor and the pass cannot disagree about which pairs collide.
 *
 * Byte-identical topics are NOT reported here: that is the ordinary
 * "one topic, two rules" duplicate, which `duplicate-preferences` already
 * covers on principle similarity. The line is the same one
 * `TopicKeyContention` draws.
 *
 * Deliberately not covered: `query.ts`'s preference lookup and
 * `intent-review.ts`'s pre-dream clustering still compare raw topic bytes,
 * so the review can cluster signals differently from the plan that acts on
 * them in the same run. Folding those changes a read path and a report
 * shape, which is a unit of its own; this check makes the condition
 * FINDABLE, which is what the warning's remedy needed.
 */
export const topicKeyCollisionCheck: DoctorCheck = {
  failSoft: true,
  run({ preferences }, { issues }) {
    const claimants = new Map<string, Map<string, string[]>>();
    for (const { pref } of preferences) {
      const key = topicKey(pref.topic);
      if (key === "") continue;
      const byTopic = claimants.get(key) ?? new Map<string, string[]>();
      byTopic.set(pref.topic, [...(byTopic.get(pref.topic) ?? []), pref.id]);
      claimants.set(key, byTopic);
    }
    for (const [key, byTopic] of [...claimants.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (byTopic.size < 2) continue;
      const topics = [...byTopic.keys()].toSorted();
      const ids = [...byTopic.values()].flat().toSorted();
      issues.push({
        severity: "warning",
        code: TOPIC_KEY_COLLISION_CODE,
        message:
          `${ids.map((id) => `[[${id}]]`).join(" and ")} claim one topic key ` +
          `${JSON.stringify(key)} with different spellings ` +
          `(${topics.map((t) => JSON.stringify(t)).join(", ")}). ` +
          "The dream pass plans nothing for a contended key: give it one owner " +
          "by renaming a topic or retiring one of the rules.",
      });
    }
  },
};

/**
 * `low-evidence-confirmed`: a confirmed pref whose `applied_count` is
 * still at or below `low_max_applied` long after its trial window
 * (`unconfirmed_window_days`). Catches prefs that promoted on the
 * minimum evidence but never saw real use — candidates for review.
 */
export const lowEvidenceConfirmedCheck: DoctorCheck = {
  failSoft: true,
  run({ config, preferences, now }, { issues }) {
    if (config === undefined) return;
    const cutoffMs = now.getTime() - config.dream.unconfirmed_window_days * DAY_MS;
    for (const { pref } of preferences) {
      if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
      if (pref.applied_count > config.confidence.low_max_applied) continue;
      if (!pref.confirmed_at) continue;
      const confirmedMs = Date.parse(pref.confirmed_at);
      if (!Number.isFinite(confirmedMs)) continue;
      if (confirmedMs >= cutoffMs) continue;
      issues.push({
        severity: "warning",
        code: "low-evidence-confirmed",
        message:
          `[[${pref.id}]] is confirmed but applied_count=${pref.applied_count} ≤ ` +
          `low_max_applied=${config.confidence.low_max_applied} after ${config.dream.unconfirmed_window_days}+ days.` +
          " The rule hasn't seen real use — review or retire.",
      });
    }
  },
};

/**
 * `pinned-without-recent-evidence`: a pinned pref whose
 * `last_evidence_at` is null or older than `stale_evidence_days`. The
 * pin protects the rule from automatic retire, but the data shows it
 * isn't actively backed — alert the user.
 */
export const pinnedWithoutRecentEvidenceCheck: DoctorCheck = {
  failSoft: true,
  run({ config, preferences, now }, { issues }) {
    if (config === undefined) return;
    const cutoffMs = now.getTime() - config.retire.stale_evidence_days * DAY_MS;
    for (const { pref } of preferences) {
      if (!pref.pinned) continue;
      if (!pref.last_evidence_at) {
        issues.push({
          severity: "warning",
          code: "pinned-without-recent-evidence",
          message:
            `[[${pref.id}]] is pinned but has never received apply-evidence.` +
            " Confirm the pin is intentional.",
        });
        continue;
      }
      const lastMs = Date.parse(pref.last_evidence_at);
      if (!Number.isFinite(lastMs)) continue;
      if (lastMs >= cutoffMs) continue;
      issues.push({
        severity: "warning",
        code: "pinned-without-recent-evidence",
        message:
          `[[${pref.id}]] is pinned but last_evidence_at=${pref.last_evidence_at} is older than ` +
          `stale_evidence_days=${config.retire.stale_evidence_days}. Pin may be outdated.`,
      });
    }
  },
};

/**
 * `content-hash-drift` (v0.12.0, Brain Integrity Suite): walks every
 * confirmed preference, recomputes the content hash from the live
 * `(principle, scope)`, and surfaces a warning whenever the stored
 * `_content_hash` no longer matches. Legacy preferences without a
 * stored hash are silent - drift detection is opt-in via the
 * promotion-time hash write.
 *
 * Hand-edits stay legal: this is observability, not enforcement. The
 * operator sees the divergence and decides whether to re-promote the
 * preference (which writes a fresh hash) or accept the drift.
 */
export const contentHashDriftCheck: DoctorCheck = {
  failSoft: true,
  run({ preferences }, { issues }) {
    for (const { path, pref } of preferences) {
      if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
      if (!pref.content_hash) continue;
      const v = verifyContentHash({
        principle: pref.principle,
        scope: pref.scope,
        content_hash: pref.content_hash,
      });
      if (!v.ok) {
        issues.push({
          severity: "warning",
          code: "content-hash-drift",
          path,
          message:
            `content-hash drift on ${pref.id}: stored ${v.observed} ` +
            `does not match recomputed ${v.expected}`,
        });
      }
    }
  },
};
