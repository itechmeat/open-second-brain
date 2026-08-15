/**
 * The quote fold merged asymmetrically, onto the wrong target, and
 * `topicKey` made that fold load-bearing for preference clustering.
 *
 * `foldQuoteVariants` maps every member of `\p{Pi}`/`\p{Pf}` (plus the
 * modifier-letter apostrophe) onto U+0027, the ASCII SINGLE quote, on the
 * stated ground that the fold "never rewrites an ASCII byte". The
 * consequence was never stated: a typographic DOUBLE quote lands on the
 * ASCII SINGLE one, so
 *
 *     SPLIT  use-"strict"   vs  use-“strict”
 *     MERGE  use-'strict'   vs  use-“strict”
 *     SPLIT  use-'strict'   vs  use-"strict"
 *     MERGE  «war»          vs  'war'
 *
 * Through `dream()` that merge is not cosmetic: two preferences on
 * `prefer-'single'-quotes` and `prefer-“single”-quotes` contend for one key,
 * the pass plans nothing for it, both rules go permanently inert to signals,
 * and the inbox accumulates.
 *
 * ## What was changed, and what deliberately was not
 *
 * `normalizeEntityName` - the entity-identity kernel - is UNCHANGED. Its
 * output is not only compared, it is PERSISTED: `truth/store.ts` writes
 * `normalizeEntityName(entity)` and `(aspect)` into an append-only claim
 * log, so re-targeting the fold would split the history of any claim whose
 * subject carries a typographic double quote, in a log that by construction
 * cannot be rewritten. Changing it would also create NEW registry duplicate
 * refusals between ASCII-double and typographic-double labels that coexist
 * on disk today. That is a migration, not a bug fix.
 *
 * `topicKey` is the opposite: its output is a Map key inside one dream pass
 * and is never written anywhere - every reported spelling is the raw topic.
 * So the class-aware fold lives there, where being wrong costs a run and
 * being changed costs nothing. Both folds live in `canonical.ts`, so quote
 * knowledge still has exactly one home.
 *
 * The class-aware fold classifies only the code points whose quote WIDTH is
 * unambiguous; Unicode publishes no property for it, and `\p{Pi}`/`\p{Pf}`
 * also contain editorial half-brackets (U+2E02…U+2E21) with no defensible
 * answer. Those keep today's target, so an unlisted or newly-assigned code
 * point degrades to the status quo rather than to a new inconsistency.
 *
 * The last test pins the doctor check that gives the contention warning's
 * remedy something behind it: before it, `o2b brain doctor` compared raw
 * topic bytes and could not surface the near-duplicate pair the warning
 * tells the operator to go find.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import {
  foldQuoteVariants,
  foldQuoteVariantsByClass,
  normalizeEntityName,
  QUOTE_VARIANT_FOLD_TARGET,
  QUOTE_VARIANT_FOLD_TARGET_DOUBLE,
} from "../../../src/core/brain/entities/canonical.ts";
import { topicKey } from "../../../src/core/brain/dream-plan.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

// U+2018/U+2019 SINGLE, U+201C/U+201D DOUBLE, U+00AB/U+00BB GUILLEMET.
const SINGLE_TYPO = "use-‘strict’";
const DOUBLE_TYPO = "use-“strict”";
const SINGLE_ASCII = "use-'strict'";
const DOUBLE_ASCII = 'use-"strict"';
const GUILLEMET = "«war»";
const WAR_SINGLE = "'war'";
const WAR_DOUBLE = '"war"';

describe("the topic fold maps each quote class to its own ASCII target", () => {
  test("a typographic double quote no longer merges with an ASCII single one", () => {
    expect(topicKey(SINGLE_ASCII)).not.toBe(topicKey(DOUBLE_TYPO));
    expect(topicKey(GUILLEMET)).not.toBe(topicKey(WAR_SINGLE));
  });

  test("a typographic double quote merges with the ASCII DOUBLE one", () => {
    expect(topicKey(DOUBLE_ASCII)).toBe(topicKey(DOUBLE_TYPO));
    expect(topicKey(GUILLEMET)).toBe(topicKey(WAR_DOUBLE));
  });

  test("the single-quote merge the fold exists for is untouched", () => {
    expect(topicKey(SINGLE_ASCII)).toBe(topicKey(SINGLE_TYPO));
    expect(topicKey("operator’s consent")).toBe(topicKey("operator's consent"));
  });

  test("the two ASCII quote forms stay distinct - the fold rewrites no ASCII byte", () => {
    expect(topicKey(SINGLE_ASCII)).not.toBe(topicKey(DOUBLE_ASCII));
    expect(foldQuoteVariantsByClass(SINGLE_ASCII)).toBe(SINGLE_ASCII);
    expect(foldQuoteVariantsByClass(DOUBLE_ASCII)).toBe(DOUBLE_ASCII);
  });
});

const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

function u(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every code point either fold touches, derived from the engine. */
function foldedCodePoints(fold: (s: string) => string): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (cp >= SURROGATE_FIRST && cp <= SURROGATE_LAST) continue;
    const ch = String.fromCodePoint(cp);
    if (fold(ch) !== ch) out.push(cp);
  }
  return out;
}

describe("the class-aware fold's footprint", () => {
  test("it touches exactly the code points the kernel fold touches", () => {
    // Same population, different targets: the class-aware fold is a
    // re-targeting, never a widening. A widened class would show up here
    // before it could reach a topic key.
    expect(foldedCodePoints(foldQuoteVariantsByClass).map(u)).toEqual(
      foldedCodePoints(foldQuoteVariants).map(u),
    );
    expect(foldedCodePoints(foldQuoteVariantsByClass).length).toBeGreaterThan(0);
  });

  test("every folded code point lands on one of exactly two ASCII targets", () => {
    const targets = new Set(
      foldedCodePoints(foldQuoteVariantsByClass).map((cp) =>
        foldQuoteVariantsByClass(String.fromCodePoint(cp)),
      ),
    );
    expect([...targets].toSorted()).toEqual(
      [QUOTE_VARIANT_FOLD_TARGET, QUOTE_VARIANT_FOLD_TARGET_DOUBLE].toSorted(),
    );
  });

  test("the double-target set is exactly the unambiguous double-quote marks", () => {
    const doubles = foldedCodePoints(foldQuoteVariantsByClass).filter(
      (cp) =>
        foldQuoteVariantsByClass(String.fromCodePoint(cp)) === QUOTE_VARIANT_FOLD_TARGET_DOUBLE,
    );
    // U+00AB «, U+00BB », U+201C “, U+201D ”, U+201F ‟. Everything else in
    // the class - the single quotes, the modifier letter, and the editorial
    // half-brackets U+2E02…U+2E21 whose width Unicode does not state - keeps
    // the single-quote target, which is what it had before this change.
    expect(doubles.map(u)).toEqual(["U+00AB", "U+00BB", "U+201C", "U+201D", "U+201F"]);
  });
});

describe("the entity-identity kernel does not move", () => {
  /**
   * Pinned deliberately, not by omission. `normalizeEntityName` feeds
   * `entityIdentityKey`, and `truth/store.ts` writes its output into an
   * append-only claim log - so this merge is on disk in vaults today and
   * re-targeting it would split a claim history that cannot be rewritten.
   */
  test("the kernel still folds every quote variant onto the single target", () => {
    expect(normalizeEntityName(GUILLEMET)).toBe(normalizeEntityName(WAR_SINGLE));
    expect(normalizeEntityName(DOUBLE_TYPO)).toBe(normalizeEntityName(SINGLE_ASCII));
    expect(foldQuoteVariants("“a”")).toBe("'a'");
  });

  test("a topic with no quote variant keys identically under both folds", () => {
    const CORPUS = [
      "deploy cadence",
      "Node.js",
      "café rules",
      "ガイド ライン",
      "AT&T",
      "  padded   spaces  ",
      "operator's consent",
    ];
    for (const topic of CORPUS) {
      expect(`${JSON.stringify(topic)}: ${topicKey(topic)}`).toBe(
        `${JSON.stringify(topic)}: ${normalizeEntityName(topic)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Through the public dream() entry point.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-05T12:00:00Z");
const SIGNAL_DAY = "2026-06-01";
const SIGNAL_STAMP = `${SIGNAL_DAY}T10:00:00Z`;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-topic-quote-"));
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

function seedSignal(vault: string, topic: string, slug: string): void {
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude",
    principle: "Ship the fold with the rule it folds.",
    created_at: SIGNAL_STAMP,
    date: SIGNAL_DAY,
    slug,
  });
}

function contentionsOf(vault: string) {
  return dream(vault, { now: NOW, dryRun: true, agentName: "claude" }).warnings.filter(
    (w) => w.code === "topic-key-contention",
  );
}

describe("two topics that differ by quote CLASS are two subjects", () => {
  test("a single-quoted and a double-quoted topic no longer contend", () => {
    const vault = newVault("classes");
    seedPreference(vault, "single-rule", "prefer-'single'-quotes");
    seedPreference(vault, "double-rule", "prefer-“single”-quotes");
    seedSignal(vault, "prefer-'single'-quotes", "a");
    seedSignal(vault, "prefer-“single”-quotes", "b");

    expect(contentionsOf(vault)).toEqual([]);
  });

  test("a contention on a genuine quote-form variant is still reported", () => {
    // The merge the fold exists for: ASCII double and typographic double are
    // one subject, so two preferences claiming it DO contend.
    const vault = newVault("still-contends");
    seedPreference(vault, "ascii-rule", 'prefer-"double"-quotes');
    seedPreference(vault, "typo-rule", "prefer-“double”-quotes");

    const contentions = contentionsOf(vault);
    expect(contentions.length).toBe(1);
    expect(contentions[0]!.message).toContain("pref-ascii-rule");
    expect(contentions[0]!.message).toContain("pref-typo-rule");
  });
});

// ---------------------------------------------------------------------------
// The doctor check behind the warning's remedy.
// ---------------------------------------------------------------------------

function bareVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "o2b-topic-doctor-"));
  const dirs = brainDirs(vault);
  mkdirSync(dirs.brain, { recursive: true });
  mkdirSync(dirs.preferences, { recursive: true });
  mkdirSync(dirs.log, { recursive: true });
  writeFileSync(
    join(dirs.brain, "_brain.yaml"),
    [
      "schema_version: 1",
      "primary_agent: null",
      "dream:",
      "  candidate_threshold: 2",
      "  unconfirmed_window_days: 7",
      "  contradiction_window_days: 14",
      "retire:",
      "  stale_evidence_days: 90",
      "confidence:",
      "  low_max_applied: 2",
      "  medium_min: 0.4",
      "  high_min: 0.7",
      "snapshots:",
      "  retention_count: 10",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dirs.brain, "_BRAIN.md"), "---\ntitle: Brain\n---\n", "utf8");
  return vault;
}

describe("o2b brain doctor can find the pair the warning names", () => {
  let vault: string;

  beforeEach(() => {
    vault = bareVault();
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  function collisionIssues() {
    const report = runDoctor(vault, { now: NOW });
    return [...report.warnings, ...report.errors].filter((i) => i.code === "topic-key-collision");
  }

  test("two preferences whose topics fold together are surfaced", () => {
    seedPreference(vault, "lower-rule", "deploy cadence");
    seedPreference(vault, "upper-rule", "Deploy Cadence");

    const issues = collisionIssues();
    expect(issues.length).toBe(1);
    // Both spellings AND both ids: the operator has to be able to open the
    // two files, and the folded key alone renders them near-identical.
    expect(issues[0]!.message).toContain("deploy cadence");
    expect(issues[0]!.message).toContain("Deploy Cadence");
    expect(issues[0]!.message).toContain("pref-lower-rule");
    expect(issues[0]!.message).toContain("pref-upper-rule");
  });

  test("a byte-identical topic is the old duplicate, not this finding", () => {
    seedPreference(vault, "one-rule", "deploy cadence");
    seedPreference(vault, "two-rule", "deploy cadence");
    expect(collisionIssues()).toEqual([]);
  });

  test("unrelated topics produce nothing", () => {
    seedPreference(vault, "one-rule", "deploy cadence");
    seedPreference(vault, "two-rule", "release notes");
    expect(collisionIssues()).toEqual([]);
  });

  test("the check agrees with the fold the dream pass uses", () => {
    // A quote-CLASS pair is two subjects to the pass, so the doctor must not
    // report it either - one fold, two surfaces.
    seedPreference(vault, "single-rule", "prefer-'single'-quotes");
    seedPreference(vault, "double-rule", "prefer-“single”-quotes");
    expect(collisionIssues()).toEqual([]);

    seedPreference(vault, "typo-rule", "prefer-“double”-quotes");
    seedPreference(vault, "ascii-rule", 'prefer-"double"-quotes');
    expect(collisionIssues().length).toBe(1);
  });
});
