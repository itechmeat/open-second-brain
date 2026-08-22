/**
 * Deterministic salience gate over the dream rollup fold set
 * (salience-lifecycle-enrichment, unit 1, t_de8a0b2d).
 *
 * Claims pinned here:
 *   1. The combined score is a weighted sum of three named components
 *      whose weights sum to exactly 1, so a score can never leave [0, 1].
 *   2. Scoring is deterministic and pure: the same components yield a
 *      byte-identical score every time, in any order.
 *   3. Each component is monotone - raising one signal never lowers the
 *      score - and an all-zero item scores exactly 0.
 *   4. A component outside its domain is refused BY NAME, never clamped:
 *      a clamped signal is a silently wrong score.
 *   5. The gate partitions at `score >= threshold`, admits the boundary
 *      case, and names every excluded item with its score.
 *   6. An absent threshold is the documented open gate: nothing is
 *      scored, `admitted === considered`, `excluded` is empty, and the
 *      verdict says the threshold is absent rather than omitting it.
 *   7. A malformed threshold is refused by name at the resolve seam,
 *      mirroring the dream-gate override doctrine (dream-gates.ts).
 *   8. The collector REUSES lessons.ts, confidence.ts and
 *      observed-use.ts: every component equals what those modules return
 *      for the same vault, so there is no second copy of that math.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeConfidence } from "../../../src/core/brain/confidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { computeLessons } from "../../../src/core/brain/lessons.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { emitObservedUse, observedReuseRates } from "../../../src/core/brain/observed-use.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../../src/core/brain/policy.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import {
  applySalienceGate,
  collectSalienceFoldSet,
  gateFoldSet,
  openSalienceGate,
  resolveSalienceThreshold,
  SALIENCE_CONFIDENCE_WEIGHT,
  SALIENCE_MASS_HALF_SATURATION,
  SALIENCE_MASS_WEIGHT,
  SALIENCE_REUSE_WEIGHT,
  SalienceGateError,
  scoreSalience,
  type SalienceFoldItem,
} from "../../../src/core/brain/salience-gate.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  type BrainConfig,
} from "../../../src/core/brain/types.ts";

const NOW = new Date("2026-06-01T00:00:00Z");

function cfgWith(threshold?: number): BrainConfig {
  const dream =
    threshold === undefined
      ? DEFAULT_BRAIN_CONFIG.dream
      : { ...DEFAULT_BRAIN_CONFIG.dream, salience_threshold: threshold };
  return { ...DEFAULT_BRAIN_CONFIG, dream };
}

function item(prefId: string, mass: number, confidence: number, reuse: number): SalienceFoldItem {
  return {
    pref_id: prefId,
    path: `Brain/preferences/${prefId}.md`,
    score: scoreSalience({ mass, confidence, reuse }),
  };
}

// ----- 1-3: the formula ----------------------------------------------------

test("the three component weights sum to exactly one", () => {
  expect(SALIENCE_MASS_WEIGHT + SALIENCE_CONFIDENCE_WEIGHT + SALIENCE_REUSE_WEIGHT).toBe(1);
});

test("an item with no signal at all scores exactly zero", () => {
  const scored = scoreSalience({ mass: 0, confidence: 0, reuse: 0 });
  expect(scored.score).toBe(0);
  expect(scored.mass_component).toBe(0);
});

test("the score is bounded by one and saturates as the decayed mass grows", () => {
  const huge = scoreSalience({ mass: 1e9, confidence: 1, reuse: 1 });
  expect(huge.score).toBeLessThanOrEqual(1);
  expect(huge.score).toBeGreaterThan(0.99);
  // Half-saturation is the documented anchor: mass == the constant maps
  // the mass component to exactly half its range.
  const half = scoreSalience({ mass: SALIENCE_MASS_HALF_SATURATION, confidence: 0, reuse: 0 });
  expect(half.mass_component).toBe(0.5);
  expect(half.score).toBe(SALIENCE_MASS_WEIGHT * 0.5);
});

test("scoring is deterministic: the same components score identically every time", () => {
  const a = scoreSalience({ mass: 1.25, confidence: 0.4, reuse: 0.75 });
  const b = scoreSalience({ mass: 1.25, confidence: 0.4, reuse: 0.75 });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("each component is monotone: raising one signal never lowers the score", () => {
  const base = scoreSalience({ mass: 1, confidence: 0.5, reuse: 0.5 }).score;
  expect(scoreSalience({ mass: 2, confidence: 0.5, reuse: 0.5 }).score).toBeGreaterThan(base);
  expect(scoreSalience({ mass: 1, confidence: 0.9, reuse: 0.5 }).score).toBeGreaterThan(base);
  expect(scoreSalience({ mass: 1, confidence: 0.5, reuse: 0.9 }).score).toBeGreaterThan(base);
});

// ----- 4: refusals rather than clamps --------------------------------------

test("a component outside its domain is refused by name, never clamped", () => {
  expect(() => scoreSalience({ mass: -1, confidence: 0, reuse: 0 })).toThrow(/mass/);
  expect(() => scoreSalience({ mass: 0, confidence: 1.5, reuse: 0 })).toThrow(/confidence/);
  expect(() => scoreSalience({ mass: 0, confidence: 0, reuse: Number.NaN })).toThrow(/reuse/);
  try {
    scoreSalience({ mass: 0, confidence: -0.1, reuse: 0 });
    throw new Error("expected a refusal");
  } catch (exc) {
    expect(exc).toBeInstanceOf(SalienceGateError);
    expect((exc as SalienceGateError).field).toBe("confidence");
  }
});

// ----- 5-6: the partition --------------------------------------------------

test("the gate admits at the threshold and names every excluded item", () => {
  const low = item("pref-low", 0, 0, 0);
  const mid = item("pref-mid", SALIENCE_MASS_HALF_SATURATION, 0, 0);
  const threshold = mid.score.score;
  const verdict = gateFoldSet([low, mid], threshold);
  expect(verdict.threshold).toBe(threshold);
  expect(verdict.considered).toBe(2);
  // Boundary case is admitted: `score >= threshold`.
  expect(verdict.admitted).toBe(1);
  expect(verdict.excluded.map((e) => e.pref_id)).toEqual(["pref-low"]);
  const excluded = verdict.excluded[0]!;
  expect(excluded.path).toBe("Brain/preferences/pref-low.md");
  expect(excluded.score).toBe(0);
  expect(excluded.mass).toBe(0);
  expect(excluded.confidence).toBe(0);
  expect(excluded.reuse).toBe(0);
});

test("the excluded list is ordered by preference id, independent of input order", () => {
  const items = [item("pref-c", 0, 0, 0), item("pref-a", 0, 0, 0), item("pref-b", 0, 0, 0)];
  const forward = gateFoldSet(items, 0.5);
  const reversed = gateFoldSet(items.toReversed(), 0.5);
  expect(forward.excluded.map((e) => e.pref_id)).toEqual(["pref-a", "pref-b", "pref-c"]);
  expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
});

test("an absent threshold is an explicitly open gate, not an omitted field", () => {
  const verdict = openSalienceGate(7);
  expect(verdict.threshold).toBeNull();
  expect("threshold" in verdict).toBe(true);
  expect(verdict.considered).toBe(7);
  expect(verdict.admitted).toBe(7);
  expect(verdict.excluded).toEqual([]);
});

// ----- 7: the config seam --------------------------------------------------

test("an unset threshold resolves to null - the documented open gate", () => {
  expect(resolveSalienceThreshold(cfgWith())).toBeNull();
});

test("a configured threshold resolves verbatim", () => {
  expect(resolveSalienceThreshold(cfgWith(0.25))).toBe(0.25);
});

test("a malformed threshold is refused by name instead of ignored", () => {
  for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => resolveSalienceThreshold(cfgWith(bad))).toThrow(/dream\.salience_threshold/);
  }
  expect(() => resolveSalienceThreshold(cfgWith("0.5" as unknown as number))).toThrow(
    /dream\.salience_threshold/,
  );
});

// ----- 8: the collector reuses the three existing signal sources -----------

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-salience-"));
  vault = join(tmp, "vault");
  bootstrapBrain(vault, {});
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write one confirmed preference with the given evidence counters. */
function seedPreference(slug: string, applied: number, violated: number): string {
  return writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-01-01T00:00:00Z",
    unconfirmed_until: "2026-01-08T00:00:00Z",
    confirmed_at: "2026-01-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    applied_count: applied,
    violated_count: violated,
    last_evidence_at: "2026-05-25T00:00:00Z",
  }).path;
}

function seedApplyEvidence(prefId: string, timestamp: string, result: string): void {
  appendLogEvent(vault, {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body: { preference: `[[${prefId}]]`, artifact: "[[src/foo.ts]]", agent: "tester", result },
  });
}

test("every collected component equals what the source module returns", () => {
  const path = seedPreference("loud", 4, 0);
  seedApplyEvidence("pref-loud", "2026-05-28T00:00:00Z", BRAIN_APPLY_RESULT.applied);
  seedApplyEvidence("pref-loud", "2026-05-29T00:00:00Z", BRAIN_APPLY_RESULT.applied);
  emitObservedUse(vault, {
    host: "test",
    createdAt: "2026-05-30T00:00:00Z",
    entries: [{ id: "pref-loud", verdict: "USED" }],
  });

  const pref = parsePreference(path);
  const cfg = cfgWith(0.1);
  const items = collectSalienceFoldSet({
    vault,
    preferences: [{ path, pref }],
    cfg,
    now: NOW,
  });
  expect(items).toHaveLength(1);
  const only = items[0]!;
  expect(only.pref_id).toBe("pref-loud");
  expect(only.path).toBe("Brain/preferences/pref-loud.md");

  const lesson = computeLessons(vault, [pref], [], { now: NOW }).find((l) => l.id === "pref-loud")!;
  expect(only.score.mass).toBe(Math.max(lesson.positiveMass, lesson.negativeMass));
  expect(only.score.confidence).toBe(
    computeConfidence(pref.applied_count, pref.violated_count, pref.last_evidence_at, cfg, NOW)
      .value,
  );
  expect(only.score.reuse).toBe(observedReuseRates(vault).get("pref-loud")!.score);
});

test("a preference with no evidence anywhere collects a zero score, not an absent one", () => {
  const path = seedPreference("silent", 0, 0);
  const items = collectSalienceFoldSet({
    vault,
    preferences: [{ path, pref: parsePreference(path) }],
    cfg: cfgWith(0.1),
    now: NOW,
  });
  expect(items).toHaveLength(1);
  expect(items[0]!.score.score).toBe(0);
});

test("applySalienceGate scores nothing when no threshold is configured", () => {
  const path = seedPreference("loud", 4, 0);
  seedApplyEvidence("pref-loud", "2026-05-29T00:00:00Z", BRAIN_APPLY_RESULT.applied);
  const verdict = applySalienceGate({
    vault,
    preferences: [{ path, pref: parsePreference(path) }],
    cfg: cfgWith(),
    now: NOW,
  });
  expect(verdict.threshold).toBeNull();
  expect(verdict.considered).toBe(1);
  expect(verdict.admitted).toBe(1);
  expect(verdict.excluded).toEqual([]);
});

test("applySalienceGate excludes the quiet preference once a threshold is set", () => {
  const loud = seedPreference("loud", 6, 0);
  const quiet = seedPreference("quiet", 0, 0);
  for (const day of ["2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"]) {
    seedApplyEvidence("pref-loud", `${day}T00:00:00Z`, BRAIN_APPLY_RESULT.applied);
  }
  const preferences = [
    { path: loud, pref: parsePreference(loud) },
    { path: quiet, pref: parsePreference(quiet) },
  ];
  const verdict = applySalienceGate({
    vault,
    preferences,
    cfg: cfgWith(0.2),
    now: NOW,
  });
  expect(verdict.considered).toBe(2);
  expect(verdict.admitted).toBe(1);
  expect(verdict.excluded.map((e) => e.pref_id)).toEqual(["pref-quiet"]);
});
