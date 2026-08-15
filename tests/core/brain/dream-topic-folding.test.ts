/**
 * Topic-key folding in the dream pass's consolidation path (D2).
 *
 * The defect: the READ path canonicalises entity references
 * (`search/entity-alias.ts` folds through `normalizeEntityName`) and the
 * CONSOLIDATION path did not. `dream-plan-topics.ts` grouped active signals
 * with `Map.get(rec.signal.topic)` and indexed existing preferences with
 * `Map.set(p.pref.topic, …)` — byte equality, no NFC, no case fold, no
 * whitespace collapse, no quote fold. Two signals whose topics differ only by
 * Unicode normal form, letter case, an internal whitespace run, or a
 * curly-versus-straight quote were consolidated as unrelated subjects, and a
 * preference already covering one of them was never found for the other.
 *
 * Every variant spelling is a named constant carrying the code points it is
 * built from, because the differences these tests turn on - a combining mark
 * versus a precomposed character, an ideographic space versus an ASCII one -
 * are invisible in an editor and unreadable at the call site.
 *
 * These tests exercise the fold through the public `dream()` entry point, so
 * they cover the whole consolidation path — grouping, the existing-preference
 * lookup, retired-suppressor matching, and the contradiction hand-off to
 * `reconcile-outcomes.ts` — rather than one internal map.
 *
 * Deliberately NOT covered here:
 *   - the exact footprint of the quote-variant class (owned and proved
 *     exhaustively by `tests/core/brain/entities/quote-variant-fold.test.ts`);
 *   - `intent-review.ts`, which clusters signals for the PRE-dream review with
 *     its own map and does not consume the plan's topics — a separate surface,
 *     outside this unit;
 *   - retire timing, confidence refresh, snapshots, and every other dream
 *     phase that keys on a preference id rather than on a topic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath, logPath, preferencePath } from "../../../src/core/brain/paths.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { BRAIN_RETIRED_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-05T12:00:00Z");
const SIGNAL_DAY = "2026-06-01";
const SIGNAL_STAMP = `${SIGNAL_DAY}T10:00:00Z`;

/** "cafe" + U+0301 COMBINING ACUTE ACCENT — the NFD spelling. */
const CAFE_NFD = "café rules";
/** U+00E9 LATIN SMALL LETTER E WITH ACUTE — the NFC spelling. */
const CAFE_NFC = "café rules";
/** NFC plus an internal whitespace run. */
const CAFE_NFC_WIDE = "café    rules";

/** U+30AC KATAKANA LETTER GA — precomposed. */
const GUIDE_NFC = "ガイド ライン";
/** U+30AB + U+3099 COMBINING KATAKANA-HIRAGANA VOICED SOUND MARK — the same. */
const GUIDE_NFD = "ガイド ライン";
/** Precomposed, with a run of U+3000 IDEOGRAPHIC SPACE for the separator. */
const GUIDE_WIDE_SPACE = "ガイド　　ライン";
/** A genuinely different caseless topic. */
const RULES_JA = "テスト規則";

/** U+2019 RIGHT SINGLE QUOTATION MARK. */
const CONSENT_CURLY = "operator’s consent";
/** U+0027 APOSTROPHE. */
const CONSENT_STRAIGHT = "operator's consent";
const CONSENT_CURLY_TITLED = "Operator’s Consent";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-topic-fold-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newVault(name: string): string {
  const vault = join(tmp, name);
  const configPath = join(tmp, `${name}.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  return vault;
}

interface SeedSignal {
  readonly topic: string;
  readonly slug: string;
  readonly sign?: "positive" | "negative";
}

function seed(vault: string, sig: SeedSignal): void {
  writeSignal(vault, {
    topic: sig.topic,
    signal: sig.sign ?? "positive",
    agent: "claude",
    principle: "Ship the fold with the rule it folds.",
    created_at: SIGNAL_STAMP,
    date: SIGNAL_DAY,
    slug: sig.slug,
  });
}

function seedPreference(vault: string, slug: string, topic: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle: `Rule of record for ${slug}.`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-15T00:00:00Z",
    confirmed_at: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-06-01T00:00:00Z",
    confidence: "medium",
  });
}

function setCandidateThreshold(vault: string, value: number): void {
  const path = brainConfigPath(vault);
  const yaml = readFileSync(path, "utf8").replace(
    /^ {2}candidate_threshold: \d+$/m,
    `  candidate_threshold: ${value}`,
  );
  atomicWriteFileSync(path, yaml);
}

function planOf(vault: string) {
  return dream(vault, { now: NOW, dryRun: true, agentName: "claude" });
}

function contentionsOf(vault: string) {
  return planOf(vault).warnings.filter((w) => w.code === "topic-key-contention");
}

describe("folding variants cluster as one topic", () => {
  test("case-only variants promote a single preference", () => {
    const vault = newVault("case");
    seed(vault, { topic: "Deploy Cadence", slug: "a" });
    seed(vault, { topic: "deploy cadence", slug: "b" });
    seed(vault, { topic: "DEPLOY CADENCE", slug: "c" });

    expect(planOf(vault).new_unconfirmed).toEqual(["pref-DEPLOY CADENCE"]);
  });

  test("normal-form and whitespace variants promote a single preference", () => {
    const vault = newVault("shape");
    seed(vault, { topic: CAFE_NFD, slug: "a" });
    seed(vault, { topic: CAFE_NFC, slug: "b" });
    seed(vault, { topic: CAFE_NFC_WIDE, slug: "c" });

    // The raw NFD spelling is the smallest in code-unit order, so it stands
    // for the group — and it is emphatically not the folded key, which is NFC.
    expect(planOf(vault).new_unconfirmed).toEqual([`pref-${CAFE_NFD}`]);
  });

  test("a curly apostrophe and a straight one are one topic", () => {
    const vault = newVault("quote");
    seed(vault, { topic: CONSENT_CURLY, slug: "a" });
    seed(vault, { topic: CONSENT_STRAIGHT, slug: "b" });
    seed(vault, { topic: CONSENT_CURLY_TITLED, slug: "c" });

    expect(planOf(vault).new_unconfirmed).toEqual([`pref-${CONSENT_CURLY_TITLED}`]);
  });
});

describe("the fold is structural, not language-specific", () => {
  test("a caseless script folds on normal form and whitespace alone", () => {
    const vault = newVault("caseless");
    seed(vault, { topic: GUIDE_NFC, slug: "a" });
    seed(vault, { topic: GUIDE_NFD, slug: "b" });
    seed(vault, { topic: GUIDE_WIDE_SPACE, slug: "c" });

    // U+30AB sorts below U+30AC, so the decomposed spelling represents the
    // group. A script with no case distinction reaches exactly one cluster by
    // the same rule that folds a cased one — nothing in the fold asks what
    // language a topic is written in.
    expect(planOf(vault).new_unconfirmed).toEqual([`pref-${GUIDE_NFD}`]);
  });

  test("two distinct caseless topics stay distinct", () => {
    const vault = newVault("caseless-distinct");
    for (const i of ["a", "b", "c"]) {
      seed(vault, { topic: GUIDE_NFC, slug: `g-${i}` });
      seed(vault, { topic: RULES_JA, slug: `t-${i}` });
    }

    expect(planOf(vault).new_unconfirmed.toSorted()).toEqual([
      `pref-${GUIDE_NFC}`,
      `pref-${RULES_JA}`,
    ]);
  });

  test("a cased non-Latin script folds on case", () => {
    const vault = newVault("cyrillic");
    seed(vault, { topic: "Правила релиза", slug: "a" });
    seed(vault, { topic: "правила релиза", slug: "b" });
    seed(vault, { topic: "ПРАВИЛА РЕЛИЗА", slug: "c" });

    expect(planOf(vault).new_unconfirmed).toEqual(["pref-ПРАВИЛА РЕЛИЗА"]);
  });
});

describe("the display form", () => {
  test("is a raw spelling from the corpus, never the folded key", () => {
    const vault = newVault("display");
    seed(vault, { topic: "Deploy Cadence", slug: "a" });
    seed(vault, { topic: "deploy cadence", slug: "b" });
    seed(vault, { topic: "Deploy  Cadence", slug: "c" });

    const summary = planOf(vault);

    // Code-unit order: U+0020 sorts below "C", so the double-spaced raw
    // spelling wins. The folded key ("deploy cadence") is never the answer.
    expect(summary.new_unconfirmed).toEqual(["pref-Deploy  Cadence"]);
  });

  test("does not depend on the order the corpus was written in", () => {
    const forward = newVault("order-forward");
    seed(forward, { topic: "Deploy Cadence", slug: "a" });
    seed(forward, { topic: "deploy cadence", slug: "b" });
    seed(forward, { topic: "DEPLOY CADENCE", slug: "c" });

    const reverse = newVault("order-reverse");
    seed(reverse, { topic: "DEPLOY CADENCE", slug: "c" });
    seed(reverse, { topic: "deploy cadence", slug: "b" });
    seed(reverse, { topic: "Deploy Cadence", slug: "a" });

    expect(planOf(forward).new_unconfirmed).toEqual(["pref-DEPLOY CADENCE"]);
    expect(planOf(reverse).new_unconfirmed).toEqual(planOf(forward).new_unconfirmed);
  });
});

describe("the existing-preference lookup folds too", () => {
  test("a signal finds the preference of record across a case variant", () => {
    const vault = newVault("pref-lookup");
    seedPreference(vault, "deploy-cadence", "Deploy Cadence");
    for (const i of ["a", "b", "c"]) seed(vault, { topic: "deploy cadence", slug: `s-${i}` });

    const summary = planOf(vault);

    // The cluster is answered AGAINST the existing rule instead of promoting
    // a second rule beside it. (The preference has no resolvable
    // `evidenced_by`, so `deriveActiveSign` takes its documented conservative
    // branch and reads a unanimous cluster as a rebuttal - which is only
    // reachable at all once the lookup finds the preference.)
    expect(summary.retired).toEqual([{ id: "ret-deploy-cadence", reason: "rebutted" }]);
    expect(summary.new_unconfirmed).toEqual(["pref-deploy-cadence-rebut"]);
  });

  test("a retired suppressor matches across a quote variant", () => {
    const vault = newVault("suppressor");
    seedPreference(vault, "operators-consent", CONSENT_CURLY);
    moveToRetired(
      vault,
      preferencePath(vault, "operators-consent"),
      BRAIN_RETIRED_REASON.userRejected,
      {
        now: new Date("2026-05-20T00:00:00Z"),
        retired_by: "test",
        evidenceApplied: [],
        evidenceViolated: [],
        user_rejected_reason: "the operator rejected this rule",
      },
    );
    for (const i of ["a", "b", "c"]) seed(vault, { topic: CONSENT_STRAIGHT, slug: `s-${i}` });

    const summary = planOf(vault);

    expect(summary.suppressed.length).toBe(3);
    expect(summary.new_unconfirmed).toEqual([]);
  });

  test("a contradiction across variants reaches reconcile with both sides", () => {
    const vault = newVault("reconcile");
    seed(vault, { topic: "Deploy Cadence", slug: "p1", sign: "positive" });
    seed(vault, { topic: "Deploy Cadence", slug: "p2", sign: "positive" });
    seed(vault, { topic: "deploy cadence", slug: "n1", sign: "negative" });
    seed(vault, { topic: "deploy cadence", slug: "n2", sign: "negative" });

    const summary = planOf(vault);

    expect(summary.contradictions).toEqual(["Deploy Cadence"]);
    expect(summary.open_questions.length).toBe(1);
    expect(summary.open_questions[0]?.positive_count).toBe(2);
    expect(summary.open_questions[0]?.negative_count).toBe(2);
  });
});

describe("two preferences contending for one folded key", () => {
  test("are named in a warning and neither one is used", () => {
    const vault = newVault("contend");
    seedPreference(vault, "deploy-cadence-upper", "Deploy Cadence");
    seedPreference(vault, "deploy-cadence-lower", "deploy cadence");
    for (const i of ["a", "b", "c"]) seed(vault, { topic: "deploy cadence", slug: `s-${i}` });

    const summary = planOf(vault);
    const contention = summary.warnings.filter((w) => w.code === "topic-key-contention");

    expect(contention.length).toBe(1);
    expect(contention[0]?.message).toContain("pref-deploy-cadence-lower");
    expect(contention[0]?.message).toContain("pref-deploy-cadence-upper");
    expect(contention[0]?.message).toContain("Deploy Cadence");
    // Nothing is decided for a key the pass cannot attribute: no new rule, no
    // retire, and the signals stay in inbox/ for the next pass.
    expect(summary.new_unconfirmed).toEqual([]);
    expect(summary.retired).toEqual([]);
    expect(summary.moved_to_processed).toEqual([]);
  });

  test("report the same message whichever preference was written first", () => {
    const forward = newVault("contend-forward");
    seedPreference(forward, "deploy-cadence-upper", "Deploy Cadence");
    seedPreference(forward, "deploy-cadence-lower", "deploy cadence");

    const reverse = newVault("contend-reverse");
    seedPreference(reverse, "deploy-cadence-lower", "deploy cadence");
    seedPreference(reverse, "deploy-cadence-upper", "Deploy Cadence");

    const a = contentionsOf(forward);

    expect(a.length).toBe(1);
    expect(a).toEqual(contentionsOf(reverse));
  });

  test("two preferences on a byte-identical topic are the old duplicate, not a contention", () => {
    const vault = newVault("duplicate");
    seedPreference(vault, "deploy-cadence-one", "deploy cadence");
    seedPreference(vault, "deploy-cadence-two", "deploy cadence");
    for (const i of ["a", "b", "c"]) seed(vault, { topic: "deploy cadence", slug: `s-${i}` });

    const summary = planOf(vault);

    expect(summary.warnings.filter((w) => w.code === "topic-key-contention")).toEqual([]);
    // Unchanged pre-fold behaviour: the first preference scanned wins and the
    // cluster is answered against it. WHICH of the two wins is directory-
    // enumeration order and always was, so the assertion is on the count.
    expect(summary.retired.length).toBe(1);
    expect(summary.moved_to_processed.length).toBe(3);
  });
});

describe("a corpus with no folding variants", () => {
  // The two goldens below were captured from the pre-fold build. They are the
  // byte-identity proof this unit owes: the fold may not move one byte of the
  // dream report for a corpus that carries no variant. Each corpus is shaped
  // so its log cannot depend on directory-enumeration order — exactly one
  // signal, so no multi-entry list can be permuted. `scanBrain` walks
  // `readdirSync`, which yields entries in whatever order the filesystem
  // stores them, and a golden over a larger corpus would be a flake, not a
  // proof.

  test("promotion writes a byte-identical dream report", () => {
    const vault = newVault("golden-promote");
    setCandidateThreshold(vault, 1);
    seed(vault, { topic: "deploy-cadence", slug: "only" });

    dream(vault, { now: NOW, agentName: "claude" });

    expect(readReport(vault)).toBe(GOLDEN_PROMOTE);
  });

  test("a rebuttal writes a byte-identical dream report", () => {
    const vault = newVault("golden-rebut");
    setCandidateThreshold(vault, 1);
    seedPreference(vault, "deploy-cadence", "deploy-cadence");
    seed(vault, { topic: "deploy-cadence", slug: "only" });

    dream(vault, { now: NOW, agentName: "claude" });

    expect(readReport(vault)).toBe(GOLDEN_REBUT);
  });
});

/**
 * The day's log with the snapshot archive's size masked. That one number
 * measures a zip this pass did not author — it moves with the compressor's
 * version, not with anything the dream decided — so pinning it would make the
 * golden a test of the environment. Every other byte is compared as written.
 */
function readReport(vault: string): string {
  return readFileSync(logPath(vault, "2026-06-05"), "utf8").replace(
    /^- size_bytes: \d+$/m,
    "- size_bytes: <masked>",
  );
}

const GOLDEN_PROMOTE = `---
kind: brain-log
date: 2026-06-05
tags: [brain, brain/log]
---

# Brain log — 2026-06-05

## 12:00:00Z — snapshot
- run_id: dream-2026-06-05-120000
- reason: dream
- size_bytes: <masked>

## 12:00:00Z — dream
- run_id: dream-2026-06-05-120000
- new_unconfirmed:
  - [[pref-deploy-cadence|Ship the fold with the rule it folds.]]
- moved_to_processed:
  - sig-2026-06-01-only
`;

const GOLDEN_REBUT = `---
kind: brain-log
date: 2026-06-05
tags: [brain, brain/log]
---

# Brain log — 2026-06-05

## 12:00:00Z — snapshot
- run_id: dream-2026-06-05-120000
- reason: dream
- size_bytes: <masked>

## 12:00:00Z — dream
- run_id: dream-2026-06-05-120000
- new_unconfirmed:
  - [[pref-deploy-cadence-rebut|Ship the fold with the rule it folds.]]
- retired:
  - [[ret-deploy-cadence|Rule of record for deploy-cadence.]] (rebutted)
- moved_to_processed:
  - sig-2026-06-01-only
`;
