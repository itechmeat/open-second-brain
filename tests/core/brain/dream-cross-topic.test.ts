/**
 * Cross-topic rule promotion (t_642bc2b8): the pure planner plus its
 * ledger helpers.
 *
 * Coverage map:
 *   - `resolveCrossTopicConfig`: absent block = off; keys override the
 *     named defaults.
 *   - `planCrossTopicRules`: cross-bucket detection at the configured
 *     `min_topics`/`jaccard`, same-bucket (and folded-same-key) clusters
 *     never firing, content-slug determinism and dedup against live or
 *     retired files, the duplicate-rule guard that keeps membership
 *     churn from re-creating a live rule (M8: principle jaccard at the
 *     same floor, or a superset of the rule's evidence, skips and
 *     discloses without writing), the per-owner-token daily budget read
 *     off the injected clock, owner-uniform source sets, and exclusion
 *     of sources the same pass plans to retire.
 *   - ledger read/write round trip through the shared atomic writer.
 *
 * Modeled on `tests/core/brain/rollup-ladder.test.ts`: the planner is a
 * pure function of its inputs, so most of the suite needs no vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CROSS_TOPIC_LEDGER_VERSION,
  DEFAULT_CROSS_TOPIC_JACCARD,
  DEFAULT_CROSS_TOPIC_MIN_TOPICS,
  MIN_CROSS_TOPIC_JACCARD,
  planCrossTopicRules,
  readCrossTopicLedger,
  resolveCrossTopicConfig,
  writeCrossTopicLedger,
  type CrossTopicLedger,
  type ResolvedCrossTopicConfig,
} from "../../../src/core/brain/dream-plan-cross-topic.ts";
import {
  emptyPlan,
  type PreferenceRecord,
  type RetiredRecord,
  type ScanResult,
} from "../../../src/core/brain/dream-plan.ts";
import type { RefreshResult } from "../../../src/core/brain/dream-refresh.ts";
import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { pageVisibility } from "../../../src/core/graph/visibility.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { tombstone } from "../../../src/core/brain/lifecycle/tombstone.ts";
import { buildReviewCandidates } from "../../../src/core/brain/review-candidates.ts";
import { stageDream, validateDreamBundle } from "../../../src/core/brain/dream-stage.ts";
import { brainConfigPath, crossTopicLedgerPath } from "../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { isoSecond } from "../../../src/core/brain/time.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../../src/core/brain/policy.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainPreference,
  type BrainPreferenceStatus,
  type BrainConfig,
} from "../../../src/core/brain/types.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";

const NOW = new Date("2026-07-19T10:00:00Z");
const TODAY = "2026-07-19";
/** Two principles sharing 5 of 7 tokens: jaccard 5/7 > the 0.6 default. */
const P_ALPHA = "prefer bun over node for scripts";
const P_BETA = "prefer bun over node for tooling";
const P_FAR = "always write the failing test first";
/** A third family: mutually near, far from both P_ALPHA and P_FAR. */
const P_BASE_A = "docker builds must pin the base image digest";
const P_BASE_B = "docker builds should pin the base image digest";

const CONFIG: ResolvedCrossTopicConfig = { minTopics: 2, jaccard: 0.6 };

function pref(overrides: Partial<BrainPreference> = {}): BrainPreference {
  return {
    kind: "brain-preference",
    id: "pref-x",
    created_at: "2026-01-01T00:00:00Z",
    confirmed_at: "2026-01-02T00:00:00Z",
    unconfirmed_until: "2026-01-08T00:00:00Z",
    tags: [],
    topic: "t",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    principle: "p",
    evidenced_by: [],
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: "low",
    confidence_value: 0,
    pinned: false,
    ...overrides,
  };
}

function rec(
  id: string,
  topic: string,
  principle: string,
  owner?: string,
  status?: BrainPreferenceStatus,
): PreferenceRecord {
  return {
    path: `/vault/Brain/preferences/${id}.md`,
    pref: pref({
      id,
      topic,
      principle,
      ...(owner ? { owner } : {}),
      ...(status ? { status } : {}),
    }),
    supersededBy: null,
  };
}

function retiredRec(id: string, topic: string, principle: string): RetiredRecord {
  return { path: `/vault/Brain/retired/${id}.md`, id, topic, principle };
}

/** A record re-scanned with `visibility:` tokens on its page. */
function withVisibility(record: PreferenceRecord, tokens: string[]): PreferenceRecord {
  return { ...record, visibility: Object.freeze(tokens) };
}

/**
 * The on-disk shape of a promoted rule after dream-refresh confirmed it
 * (one applied event auto-confirms it): an ordinary preference carrying
 * the `cross-` slug, `inferred` provenance and its evidence lineage.
 * `evidencedBy` overrides the self-citing default; `owner` stamps the
 * rule's owner token.
 */
function promotedRec(
  id: string,
  topic: string,
  principle: string,
  evidencedBy?: string[],
  owner?: string,
): PreferenceRecord {
  return {
    path: `/vault/Brain/preferences/${id}.md`,
    pref: pref({
      id,
      topic,
      principle,
      provenance: "inferred",
      evidenced_by: evidencedBy ?? [`[[${id}]]`],
      ...(owner ? { owner } : {}),
    }),
    supersededBy: null,
  };
}

const NO_REFRESH: RefreshResult = {
  confirmed: new Set(),
  updated: new Map(),
  bandDrops: [],
  outcomeRegressions: [],
};

function scanOf(preferences: PreferenceRecord[], retired: RetiredRecord[] = []): ScanResult {
  return { signals: [], preferences, retired, corrupted: [] };
}

/**
 * Run the planner over a scan, returning the result AND the mutated plan.
 * `tombstonedPaths` / `corruptedPaths` are preferences-dir files the scan
 * saw but did not parse into records: a tombstone keeps the file in place
 * and an unparseable one lands in `scan.corrupted`.
 */
function plan(
  preferences: PreferenceRecord[],
  opts: {
    config?: ResolvedCrossTopicConfig | null;
    ledger?: CrossTopicLedger | null;
    now?: Date;
    refresh?: RefreshResult;
    retired?: RetiredRecord[];
    retireSlugs?: string[];
    tombstonedPaths?: string[];
    corruptedPaths?: string[];
  } = {},
) {
  const planState = emptyPlan();
  for (const slug of opts.retireSlugs ?? []) {
    planState.retires.push({ slug, principle: "x", reason: BRAIN_RETIRED_REASON.staleNoEvidence });
  }
  const scan: ScanResult = {
    ...scanOf(preferences, opts.retired ?? []),
    ...(opts.tombstonedPaths
      ? { tombstonedPreferences: opts.tombstonedPaths.map((path) => ({ path })) }
      : {}),
    ...(opts.corruptedPaths ? { corrupted: opts.corruptedPaths.map((path) => ({ path })) } : {}),
  };
  const result = planCrossTopicRules({
    scan,
    refresh: opts.refresh ?? NO_REFRESH,
    config: opts.config === undefined ? CONFIG : opts.config,
    ledger: opts.ledger ?? null,
    now: opts.now ?? NOW,
    plan: planState,
  });
  return { result, plan: planState };
}

/** The content slug the planner must derive for a sorted source-id set. */
function expectedSlug(...ids: string[]): string {
  return `cross-${sha256Hex(ids.sort().join("\n")).slice(0, 12)}`;
}

describe("resolveCrossTopicConfig", () => {
  test("an absent block resolves to null (feature off)", () => {
    expect(resolveCrossTopicConfig(DEFAULT_BRAIN_CONFIG)).toBeNull();
  });

  test("enabled: false resolves to null", () => {
    const cfg: BrainConfig = {
      ...DEFAULT_BRAIN_CONFIG,
      cross_topic: { enabled: false },
    };
    expect(resolveCrossTopicConfig(cfg)).toBeNull();
  });

  test("enabled with no keys resolves the named defaults", () => {
    const cfg: BrainConfig = { ...DEFAULT_BRAIN_CONFIG, cross_topic: { enabled: true } };
    expect(resolveCrossTopicConfig(cfg)).toEqual({
      minTopics: DEFAULT_CROSS_TOPIC_MIN_TOPICS,
      jaccard: DEFAULT_CROSS_TOPIC_JACCARD,
    });
  });

  test("declared keys override the defaults", () => {
    const cfg: BrainConfig = {
      ...DEFAULT_BRAIN_CONFIG,
      cross_topic: { enabled: true, min_topics: 3, jaccard: 0.8 },
    };
    expect(resolveCrossTopicConfig(cfg)).toEqual({ minTopics: 3, jaccard: 0.8 });
  });

  // ----- Config floors (review findings 62 and 82) -------------------------
  // The parser contract promises out-of-range but well-formed values are
  // "clamped (and the clamp disclosed) by the consumer that resolves it".
  // `min_topics: 1` elects singletons and `jaccard: 0` unions every
  // same-owner cross-bucket pair into one arbitrary cluster, so the
  // resolver owns the floors and names every clamp.

  test("min_topics below two is floored to two with a disclosure", () => {
    const cfg: BrainConfig = {
      ...DEFAULT_BRAIN_CONFIG,
      cross_topic: { enabled: true, min_topics: 1 },
    };
    const disclosures: string[] = [];
    const resolved = resolveCrossTopicConfig(cfg, (code, message) =>
      disclosures.push(`${code}: ${message}`),
    );
    expect(resolved).toEqual({
      minTopics: DEFAULT_CROSS_TOPIC_MIN_TOPICS,
      jaccard: DEFAULT_CROSS_TOPIC_JACCARD,
    });
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("cross_topic.min_topics");
    expect(disclosures[0]).toContain("2");
  });

  test("jaccard below the merge-suggestion floor is floored with a disclosure", () => {
    const cfg: BrainConfig = {
      ...DEFAULT_BRAIN_CONFIG,
      cross_topic: { enabled: true, jaccard: 0 },
    };
    const disclosures: string[] = [];
    const resolved = resolveCrossTopicConfig(cfg, (code, message) =>
      disclosures.push(`${code}: ${message}`),
    );
    expect(resolved).toEqual({
      minTopics: DEFAULT_CROSS_TOPIC_MIN_TOPICS,
      jaccard: MIN_CROSS_TOPIC_JACCARD,
    });
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("cross_topic.jaccard");
  });

  test("in-range knobs pass through untouched with no disclosure", () => {
    const cfg: BrainConfig = {
      ...DEFAULT_BRAIN_CONFIG,
      cross_topic: { enabled: true, min_topics: 3, jaccard: 0.8 },
    };
    const disclosures: string[] = [];
    expect(
      resolveCrossTopicConfig(cfg, (code, message) => disclosures.push(`${code}: ${message}`)),
    ).toEqual({ minTopics: 3, jaccard: 0.8 });
    expect(disclosures).toEqual([]);
  });

  test("the floors apply only when the feature is on", () => {
    const disclosures: string[] = [];
    // Off: null, and the sink never fires.
    expect(
      resolveCrossTopicConfig(DEFAULT_BRAIN_CONFIG, (code, message) =>
        disclosures.push(`${code}: ${message}`),
      ),
    ).toBeNull();
    expect(disclosures).toEqual([]);
  });
});

describe("planCrossTopicRules", () => {
  test("fires across two buckets at the configured thresholds and pins the entry shape", () => {
    const { result, plan: planState } = plan([
      rec("pref-alpha", "Alpha", P_ALPHA),
      rec("pref-beta", "Beta", P_BETA),
    ]);
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
    const entry = planState.crossTopicRules[0]!;
    expect(entry.slug).toBe(expectedSlug("pref-alpha", "pref-beta"));
    // Representative principle: the lexicographically smallest source, verbatim.
    expect(entry.principle).toBe(P_ALPHA);
    // Deterministic synthetic topic: sorted raw displays joined.
    expect(entry.topic).toBe("Alpha + Beta");
    expect([...entry.evidencedBy]).toEqual(["[[pref-alpha]]", "[[pref-beta]]"]);
    expect([...entry.related]).toEqual(["pref-alpha", "pref-beta"]);
    expect(entry.owner).toBeUndefined();
    // Default-visibility sources promote a default-visibility rule.
    expect(entry.visibility).toEqual([]);
    // The returned ledger stamps the shared (ownerless) token with today.
    expect(result.ledger?.version).toBe(CROSS_TOPIC_LEDGER_VERSION);
    expect(result.ledger?.last_promoted[""]).toBe(TODAY);
  });

  test("same-bucket clusters never fire", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "docker", P_ALPHA),
      rec("pref-b", "docker", P_BETA),
      rec("pref-c", "docker", P_ALPHA),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("topics that fold onto one key are one bucket, not two", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "Docker", P_ALPHA),
      rec("pref-b", "docker", P_BETA),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("a pair below the jaccard threshold never fires", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA),
      rec("pref-b", "Beta", P_FAR),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("a cluster spanning fewer buckets than min_topics never fires", () => {
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      { config: { minTopics: 3, jaccard: 0.6 } },
    );
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("a null config (feature off) plans nothing", () => {
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      { config: null },
    );
    expect(result.fired).toBe(false);
    expect(result.ledger).toBeNull();
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("only confirmed preferences are sources; a pref confirmed this run qualifies", () => {
    const unconfirmed = rec(
      "pref-a",
      "Alpha",
      P_ALPHA,
      undefined,
      BRAIN_PREFERENCE_STATUS.unconfirmed,
    );
    const cold = plan([unconfirmed, rec("pref-b", "Beta", P_BETA)]);
    expect(cold.result.fired).toBe(false);

    const promoted = plan([unconfirmed, rec("pref-b", "Beta", P_BETA)], {
      refresh: { ...NO_REFRESH, confirmed: new Set(["a"]) },
    });
    expect(promoted.result.fired).toBe(true);
  });

  test("the slug is content-derived: the same source set maps to one file in any scan order", () => {
    const first = plan([rec("pref-alpha", "Alpha", P_ALPHA), rec("pref-beta", "Beta", P_BETA)]);
    const second = plan([rec("pref-beta", "Beta", P_BETA), rec("pref-alpha", "Alpha", P_ALPHA)]);
    expect(first.plan.crossTopicRules[0]!.slug).toBe(second.plan.crossTopicRules[0]!.slug);
    expect(first.plan.crossTopicRules[0]!.slug).toBe(expectedSlug("pref-alpha", "pref-beta"));
  });

  test("a slug already present live or in retired/ skips the cluster", () => {
    const sources = [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)];
    const slug = expectedSlug("pref-a", "pref-b");

    const live = plan([...sources, rec(`pref-${slug}`, "already promoted", P_FAR)]);
    expect(live.result.fired).toBe(false);
    expect(live.plan.crossTopicRules).toHaveLength(0);

    const retired = plan(sources, { retired: [retiredRec(`ret-${slug}`, "gone", P_FAR)] });
    expect(retired.result.fired).toBe(false);
    expect(retired.plan.crossTopicRules).toHaveLength(0);
  });

  // ----- Visibility of the promoted rule (review finding 63) --------------
  // The rule restates its representative source's principle VERBATIM, so
  // it may never be more public than the most restricted member. The
  // topic plan's strictest-visibility rule, over the cluster members.

  test("a restricted source's rule carries that restriction (finding 63)", () => {
    const { plan: planState } = plan([
      withVisibility(rec("pref-a", "Alpha", P_ALPHA), ["private"]),
      rec("pref-b", "Beta", P_BETA),
    ]);
    expect(planState.crossTopicRules).toHaveLength(1);
    expect(planState.crossTopicRules[0]!.visibility).toEqual(["private"]);
  });

  test("a visibility intersection that misses falls closed on the reserved token", () => {
    const { plan: planState } = plan([
      withVisibility(rec("pref-a", "Alpha", P_ALPHA), ["team"]),
      withVisibility(rec("pref-b", "Beta", P_BETA), ["agent:x"]),
    ]);
    expect(planState.crossTopicRules).toHaveLength(1);
    expect(planState.crossTopicRules[0]!.visibility).toEqual(["private"]);
  });

  test("the strictest of several restricted sources wins", () => {
    const { plan: planState } = plan([
      withVisibility(rec("pref-a", "Alpha", P_ALPHA), ["team", "agent:x"]),
      withVisibility(rec("pref-b", "Beta", P_BETA), ["team"]),
    ]);
    expect(planState.crossTopicRules[0]!.visibility).toEqual(["team"]);
  });

  // ----- Tombstoned / corrupted slugs are still taken (review finding 64) --
  // Precision (review round 2): `scan.corrupted` holds unparseable files
  // from the signal directories and `retired/` too, but only a file under
  // `Brain/preferences/` can collide with apply's `overwrite: false`
  // write - the slug match must consider that directory alone.

  test("a tombstoned pref-cross file takes its slug (finding 64)", () => {
    const slug = expectedSlug("pref-a", "pref-b");
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      { tombstonedPaths: [`/vault/Brain/preferences/pref-${slug}.md`] },
    );
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("a corrupted pref-cross file under preferences/ takes its slug too", () => {
    const slug = expectedSlug("pref-a", "pref-b");
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      { corruptedPaths: [`/vault/Brain/preferences/pref-${slug}.md`] },
    );
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("a corrupted pref-cross file outside preferences/ never blocks (round 2)", () => {
    const slug = expectedSlug("pref-a", "pref-b");
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      {
        corruptedPaths: [
          `/vault/Brain/retired/pref-${slug}.md`,
          `/vault/Brain/inbox/pref-${slug}.md`,
        ],
      },
    );
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
  });

  test("an unrelated tombstoned file takes nothing", () => {
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      { tombstonedPaths: ["/vault/Brain/preferences/pref-unrelated.md"] },
    );
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
  });

  test("one promotion per owner token per calendar day, dated from the injected now", () => {
    const sources = [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)];
    const spent: CrossTopicLedger = {
      version: CROSS_TOPIC_LEDGER_VERSION,
      last_promoted: { "": TODAY },
    };
    const budgeted = plan(sources, { ledger: spent });
    expect(budgeted.result.fired).toBe(false);
    expect(budgeted.plan.crossTopicRules).toHaveLength(0);

    // The same ledger the next day has budget again, and the date comes
    // from the injected clock, never the wall clock.
    const nextDay = plan(sources, {
      ledger: spent,
      now: new Date("2026-07-20T10:00:00Z"),
    });
    expect(nextDay.result.fired).toBe(true);
    expect(nextDay.result.ledger?.last_promoted[""]).toBe("2026-07-20");
  });

  test("mixed-owner source sets never fire (no owner leak through a merged rule)", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA, "kate"),
      rec("pref-b", "Beta", P_BETA, "sam"),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("owned sources stamp the shared owner token and budget under it", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA, "kate"),
      rec("pref-b", "Beta", P_BETA, "kate"),
    ]);
    expect(result.fired).toBe(true);
    const entry = planState.crossTopicRules[0]!;
    expect(entry.owner).toBe("kate");
    expect(result.ledger?.last_promoted["kate"]).toBe(TODAY);
    expect(result.ledger?.last_promoted[""]).toBeUndefined();
  });

  test("a source the same pass plans to retire is not eligible", () => {
    const { result, plan: planState } = plan(
      [rec("pref-a", "Alpha", P_ALPHA), rec("pref-b", "Beta", P_BETA)],
      { retireSlugs: ["a"] },
    );
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("two disjoint clusters with distinct owners both fire, each under its own budget", () => {
    const kateCluster = [
      rec("pref-a1", "Alpha", P_ALPHA, "kate"),
      rec("pref-a2", "Beta", P_BETA, "kate"),
    ];
    const samCluster = [
      rec("pref-b1", "Gamma", P_ALPHA, "sam"),
      rec("pref-b2", "Delta", P_BETA, "sam"),
    ];
    const { result, plan: planState } = plan([...kateCluster, ...samCluster]);
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(2);
    const owners = planState.crossTopicRules.map((e) => e.owner).sort();
    expect(owners).toEqual(["kate", "sam"]);
    expect(result.ledger?.last_promoted["kate"]).toBe(TODAY);
    expect(result.ledger?.last_promoted["sam"]).toBe(TODAY);
  });

  test("an owner budgeted out today still lets another owner fire", () => {
    const spent: CrossTopicLedger = {
      version: CROSS_TOPIC_LEDGER_VERSION,
      last_promoted: { kate: TODAY },
    };
    const { result, plan: planState } = plan(
      [
        rec("pref-a1", "Alpha", P_ALPHA, "kate"),
        rec("pref-a2", "Beta", P_BETA, "kate"),
        rec("pref-b1", "Gamma", P_ALPHA, "sam"),
        rec("pref-b2", "Delta", P_BETA, "sam"),
      ],
      { ledger: spent },
    );
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
    expect(planState.crossTopicRules[0]!.owner).toBe("sam");
    expect(result.ledger?.last_promoted["kate"]).toBe(TODAY);
    expect(result.ledger?.last_promoted["sam"]).toBe(TODAY);
  });

  // ----- Self-cluster re-promotion (review finding 61) ---------------------
  // The promoted rule restates its representative source verbatim (jaccard
  // 1.0) and folds to its own topic key, so once refresh confirms it, the
  // rule itself qualifies as a source and every later pass "discovers" a
  // new cross-topic cluster containing it - one promotion per owner per
  // day, forever. A promoted rule is therefore never a source.

  test("a confirmed promoted rule never re-enters the source pool on a later day", () => {
    const slug = expectedSlug("pref-a", "pref-b");
    const day2 = new Date("2026-07-20T10:00:00Z");
    const spent: CrossTopicLedger = {
      version: CROSS_TOPIC_LEDGER_VERSION,
      last_promoted: { "": TODAY },
    };
    // Day 2: the rule was confirmed overnight; the two stated sources and
    // the promoted rule are all live.
    const { result, plan: planState } = plan(
      [
        rec("pref-a", "Alpha", P_ALPHA),
        rec("pref-b", "Beta", P_BETA),
        promotedRec(`pref-${slug}`, "Alpha + Beta", P_ALPHA),
      ],
      { ledger: spent, now: day2 },
    );
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("an inferred preference renamed away from the cross- prefix is still excluded", () => {
    // The provenance identifier catches a promoted rule whose file a hand
    // renamed: it still restates its source verbatim and folds to its own
    // key, so it must not become a source either.
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA),
      promotedRec("pref-handrenamed", "Beta", P_ALPHA),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  test("a stated preference carrying a cross-prefixed id is also excluded", () => {
    // The slug prefix is the reserved content shape; a hand-authored file
    // that kept it gets the same treatment.
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA),
      rec("pref-cross-handmade", "Beta", P_ALPHA),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
  });

  // ----- Duplicate-rule guard (M8) -----------------------------------------
  // The slug hashes the EXACT source set, so membership churn - one
  // source joining or leaving a promoted cluster - mints a new slug and,
  // before the guard, a second live rule stating the identical principle
  // while the first stays live. Before promoting, the planner compares
  // the candidate against the owner's existing inferred `cross-` rules
  // (the very records it excludes from the source pool): a
  // near-identical principle at the same jaccard floor the clusters
  // elect at, or a source set that already superset-evidences the rule,
  // skips the promotion - disclosed on the planner's result the same way
  // the daily budget's skips are: nothing written, no budget spent.

  test("membership churn mints no second rule: the guard skips and discloses (M8)", () => {
    const day1Slug = expectedSlug("pref-a", "pref-b");
    const day1Ledger: CrossTopicLedger = {
      version: CROSS_TOPIC_LEDGER_VERSION,
      last_promoted: { "": "2026-07-19" },
    };
    // Day 3: Gamma joined the promoted cluster before the day-1 rule
    // ever confirmed (still unconfirmed - the guard does not wait for
    // confirmation). The joined set elects under a NEW content slug, so
    // the exact-set slug dedup cannot catch it; the principle guard must.
    const { result, plan: planState } = plan(
      [
        rec("pref-a", "Alpha", P_ALPHA),
        rec("pref-b", "Beta", P_BETA),
        rec("pref-c", "Gamma", P_ALPHA),
        promotedRec(`pref-${day1Slug}`, "Alpha + Beta", P_ALPHA),
      ],
      { now: new Date("2026-07-21T10:00:00Z"), ledger: day1Ledger },
    );
    expect(expectedSlug("pref-a", "pref-b", "pref-c")).not.toBe(day1Slug);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
    // Nothing written: the day-3 budget stays unspent, the ledger update
    // is null.
    expect(result.ledger).toBeNull();
    // The skip is disclosed with its reason and the rule it duplicates.
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0]!.code).toBe("cross-topic-duplicate-rule");
    expect(result.skips[0]!.message).toContain(`pref-${day1Slug}`);
  });

  test("a cluster that only extends a live rule's evidence skips too (superset branch)", () => {
    // The old rule's principle has drifted below the floor from the
    // cluster's current representative (a source rewrite since the
    // promotion), but the cluster's sources already evidence the rule:
    // extending that evidence is a future concern, not a second rule.
    const { result, plan: planState } = plan([
      rec("pref-c", "Gamma", P_BASE_A),
      rec("pref-d", "Delta", P_BASE_B),
      promotedRec("pref-cross-manual", "Gamma + Delta", P_FAR, ["[[pref-c]]", "[[pref-d]]"]),
    ]);
    expect(result.fired).toBe(false);
    expect(planState.crossTopicRules).toHaveLength(0);
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0]!.code).toBe("cross-topic-duplicate-rule");
    expect(result.skips[0]!.message).toContain("pref-cross-manual");
  });

  test("a genuinely different principle still promotes beside an existing rule", () => {
    const { result, plan: planState } = plan([
      rec("pref-c", "Gamma", P_BASE_A),
      rec("pref-d", "Delta", P_BASE_B),
      promotedRec("pref-cross-manual", "Alpha + Beta", P_ALPHA),
    ]);
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
    expect(planState.crossTopicRules[0]!.slug).toBe(expectedSlug("pref-c", "pref-d"));
    expect(result.skips).toHaveLength(0);
  });

  test("the guard is owner-scoped: another owner's rule never blocks a cluster", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA),
      rec("pref-b", "Beta", P_BETA),
      promotedRec("pref-cross-kates", "Alpha + Beta", P_ALPHA, undefined, "kate"),
    ]);
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
    expect(planState.crossTopicRules[0]!.owner).toBeUndefined();
    expect(result.skips).toHaveLength(0);
  });

  test("a guard skip spends no daily budget: a different cluster still promotes that day", () => {
    const { result, plan: planState } = plan([
      rec("pref-a", "Alpha", P_ALPHA),
      rec("pref-b", "Beta", P_BETA),
      rec("pref-c", "Gamma", P_BASE_A),
      rec("pref-d", "Delta", P_BASE_B),
      promotedRec("pref-cross-manual", "Alpha + Beta", P_ALPHA, ["[[pref-a]]", "[[pref-b]]"]),
    ]);
    // The duplicate cluster skips (the manual rule cites exactly its
    // sources), the different-principle cluster still fires under the
    // same owner token on the same day.
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules.map((e) => e.slug)).toEqual([
      expectedSlug("pref-c", "pref-d"),
    ]);
    expect(result.ledger?.last_promoted[""]).toBe(TODAY);
    expect(result.skips).toHaveLength(1);
  });

  test("an existing rule this pass retires does not guard its replacement", () => {
    const day1Slug = expectedSlug("pref-a", "pref-b");
    const { result, plan: planState } = plan(
      [
        rec("pref-a", "Alpha", P_ALPHA),
        rec("pref-b", "Beta", P_BETA),
        rec("pref-c", "Gamma", P_ALPHA),
        promotedRec(`pref-${day1Slug}`, "Alpha + Beta", P_ALPHA),
      ],
      { now: new Date("2026-07-21T10:00:00Z"), retireSlugs: [day1Slug] },
    );
    expect(result.fired).toBe(true);
    expect(planState.crossTopicRules).toHaveLength(1);
    expect(planState.crossTopicRules[0]!.slug).toBe(expectedSlug("pref-a", "pref-b", "pref-c"));
    expect(result.skips).toHaveLength(0);
  });
});

describe("cross-topic ledger", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-cross-topic-ledger-"));
    bootstrapBrain(vault, {});
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("an absent ledger reads as null and a corrupt one fails open", () => {
    expect(readCrossTopicLedger(vault)).toBeNull();
    const ledgerPath = crossTopicLedgerPath(vault);
    require("node:fs").writeFileSync(ledgerPath, "{not json", "utf8");
    expect(readCrossTopicLedger(vault)).toBeNull();
  });

  test("write then read round-trips through the atomic writer", () => {
    const ledger: CrossTopicLedger = {
      version: CROSS_TOPIC_LEDGER_VERSION,
      last_promoted: { kate: TODAY },
    };
    writeCrossTopicLedger(vault, ledger);
    const path = crossTopicLedgerPath(vault);
    expect(existsSync(path)).toBe(true);
    expect(readCrossTopicLedger(vault)).toEqual(ledger);
    expect(readFileSync(path, "utf8")).toContain('"kate"');
  });
});

// ----- End to end: the promotion inside one dream pass (t_642bc2b8, A2) -----

/**
 * The same claims the planner suite pins, now through `dream()` on the
 * `dream-destructive-gate` pattern: a fired promotion counts as a state
 * change, writes an `inferred` preference with evidence lineage through
 * the transactional writer, lands the ledger beside the rollup ledger,
 * and keeps every non-firing path byte-identical - no-op summary, no
 * ledger, no log file.
 */
describe("dream pass wiring (end to end)", () => {
  const NOW_E2E = new Date("2026-07-19T10:00:00Z");
  const ENABLED = "schema_version: 1\ncross_topic:\n  enabled: true\n";
  const SILENT = "schema_version: 1\n";

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-cross-topic-e2e-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeVault(name: string, configYaml: string): string {
    const vault = join(tmp, name);
    bootstrapBrain(vault, {});
    atomicWriteFileSync(brainConfigPath(vault), configYaml);
    return vault;
  }

  /** Two confirmed sources in two buckets, principles 5/7 apart. */
  function seedPair(vault: string, principleA = P_ALPHA, principleB = P_BETA): void {
    for (const [slug, topic, principle] of [
      ["alpha", "Alpha", principleA],
      ["beta", "Beta", principleB],
    ] as const) {
      writePreference(vault, {
        slug,
        topic,
        principle,
        created_at: "2026-01-01T00:00:00Z",
        unconfirmed_until: "2026-01-08T00:00:00Z",
        // Recent confirmation keeps the stale-no-evidence auto-retire
        // off both sources (see dream-salience-gate.test.ts).
        confirmed_at: "2026-07-17T00:00:00Z",
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        evidenced_by: [],
        applied_count: 0,
        violated_count: 0,
        last_evidence_at: null,
        confidence_value: 0,
      });
    }
  }

  function logFiles(vault: string): string[] {
    const logDir = join(vault, "Brain", "log");
    return existsSync(logDir) ? readdirSync(logDir).map((f) => join(logDir, f)) : [];
  }

  test("a fired promotion writes an inferred pref with lineage and lands the ledger", () => {
    const vault = makeVault("fired", ENABLED);
    seedPair(vault);
    const alphaBefore = readFileSync(join(vault, "Brain", "preferences", "pref-alpha.md"));
    const betaBefore = readFileSync(join(vault, "Brain", "preferences", "pref-beta.md"));

    const summary = dream(vault, { now: NOW_E2E });

    // The promotion alone carries the changed gate.
    expect(summary.changed).toBe(true);
    const slug = expectedSlug("pref-alpha", "pref-beta");
    expect(summary.cross_topic_rules).toEqual([`pref-${slug}`]);
    expect(summary.phases.find((p) => p.phase === "synthesize")?.metrics["cross_topic_rules"]).toBe(
      1,
    );

    // The written rule: ordinary unconfirmed preference, inferred
    // provenance, evidence wikilinks and related lineage, trial window
    // from the pass's clock.
    const rule = parsePreference(join(vault, "Brain", "preferences", `pref-${slug}.md`));
    expect(rule.provenance).toBe("inferred");
    expect(rule.status).toBe(BRAIN_PREFERENCE_STATUS.unconfirmed);
    expect(rule.topic).toBe("Alpha + Beta");
    expect(rule.principle).toBe(P_ALPHA);
    expect([...rule.evidenced_by]).toEqual(["[[pref-alpha]]", "[[pref-beta]]"]);
    expect([...(rule.related ?? [])]).toEqual(["pref-alpha", "pref-beta"]);
    expect(rule.unconfirmed_until).toBe(
      isoSecond(
        new Date(
          NOW_E2E.getTime() + DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days * 24 * 3600 * 1000,
        ),
      ),
    );

    // The ledger, beside the rollup ledger's write discipline.
    expect(readCrossTopicLedger(vault)?.last_promoted[""]).toBe("2026-07-19");

    // The audit trail names the rule (device-sharded day files included).
    const logBody = logFiles(vault)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(logBody).toContain(`pref-${slug}`);

    // Sources are untouched: never modified, never retired. (The
    // pass machinery may create the empty `retired/` directory even
    // with zero retires; what must not happen is a retired FILE.)
    expect(readFileSync(join(vault, "Brain", "preferences", "pref-alpha.md"))).toEqual(alphaBefore);
    expect(readFileSync(join(vault, "Brain", "preferences", "pref-beta.md"))).toEqual(betaBefore);
    const retiredDir = join(vault, "Brain", "retired");
    expect(
      existsSync(retiredDir) ? readdirSync(retiredDir).filter((f) => f.endsWith(".md")) : [],
    ).toEqual([]);
  });

  test("a restricted source's promoted rule is not public (finding 63)", () => {
    const vault = makeVault("restricted", ENABLED);
    // One source carries `visibility: [private]`; the rule restates its
    // principle verbatim and must land at that visibility, not the
    // default. The copied `owner` token does not substitute.
    writePreference(vault, {
      slug: "alpha",
      topic: "Alpha",
      principle: P_ALPHA,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      confirmed_at: "2026-07-17T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence_value: 0,
      visibility: ["private"],
    });
    writePreference(vault, {
      slug: "beta",
      topic: "Beta",
      principle: P_BETA,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      confirmed_at: "2026-07-17T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence_value: 0,
    });

    const summary = dream(vault, { now: NOW_E2E });
    expect(summary.changed).toBe(true);

    const slug = expectedSlug("pref-alpha", "pref-beta");
    const rulePath = join(vault, "Brain", "preferences", `pref-${slug}.md`);
    // The typed parser drops the field; the frontmatter is the contract.
    const rule = parsePreference(rulePath);
    expect(rule.provenance).toBe("inferred");
    expect(pageVisibility(parseFrontmatter(rulePath)[0])).toEqual(["private"]);

    // First counter change (review round 2): one applied event confirms the
    // rule, and the refresh update loop rewrites it. The rule - and the
    // restricted source alpha - carry a `visibility:` line on disk, so the
    // update must carry the tokens through the rewrite AND the no-op
    // pre-flight must be able to render them; a render that omits the line
    // can never match the file, and every later pass rewrites both files
    // with a `_revision` bump.
    const DAY2 = new Date("2026-07-20T10:00:00Z");
    appendApplyEvidence(
      vault,
      {
        pref_id: `pref-${slug}`,
        artifact: "[[Daily/2026.07.20]]",
        result: "applied",
        agent: "test",
      },
      { now: DAY2 },
    );
    dream(vault, { now: DAY2 });
    const changed = parsePreference(rulePath);
    expect(changed.applied_count).toBe(1);
    // The restriction survives the counter-change rewrite.
    expect(pageVisibility(parseFrontmatter(rulePath)[0])).toEqual(["private"]);

    // And the pass after it is a true no-op: same injected now, byte-
    // identical file, nothing counted as changed.
    const before = readFileSync(rulePath);
    const rerun = dream(vault, { now: DAY2 });
    expect(rerun.changed).toBe(false);
    expect(readFileSync(rulePath)).toEqual(before);
  });

  test("a tombstoned promotion never re-fires the slug collision (finding 64)", () => {
    const vault = makeVault("tombstoned", ENABLED);
    seedPair(vault);
    const slug = expectedSlug("pref-alpha", "pref-beta");
    const rulePath = join(vault, "Brain", "preferences", `pref-${slug}.md`);

    dream(vault, { now: NOW_E2E });
    expect(existsSync(rulePath)).toBe(true);

    // Tombstone the promoted file in place: the lifecycle keeps the bytes
    // on disk under `_status: tombstoned`, and the scan drops the record.
    tombstone({
      vault,
      path: `Brain/preferences/pref-${slug}.md`,
      reason: "superseded by hand",
      now: new Date("2026-07-19T12:00:00Z"),
    });

    // Before the fix this pass re-planned the identical content-derived
    // slug and apply's overwrite:false write threw on the live path,
    // blocking every later dream run.
    const day2 = dream(vault, { now: new Date("2026-07-20T10:00:00Z") });
    expect(day2.cross_topic_rules).toBeUndefined();
    expect(existsSync(rulePath)).toBe(true);
  });

  test("a same-day rerun is a no-op: slug dedup below the changed gate", () => {
    const vault = makeVault("rerun", ENABLED);
    seedPair(vault);
    const first = dream(vault, { now: NOW_E2E });
    expect(first.changed).toBe(true);
    const ledgerBefore = readFileSync(crossTopicLedgerPath(vault));

    const second = dream(vault, { now: NOW_E2E });
    expect(second.changed).toBe(false);
    expect(second.cross_topic_rules).toBeUndefined();
    expect(readFileSync(crossTopicLedgerPath(vault))).toEqual(ledgerBefore);
  });

  test("a below-threshold pass is byte-identical: no-op summary, no ledger, no log", () => {
    const vault = makeVault("quiet", ENABLED);
    seedPair(vault, P_ALPHA, P_FAR);

    const summary = dream(vault, { now: NOW_E2E });

    expect(summary.changed).toBe(false);
    expect(summary.cross_topic_rules).toBeUndefined();
    expect(existsSync(crossTopicLedgerPath(vault))).toBe(false);
    expect(logFiles(vault)).toEqual([]);
  });

  test("the block absent keeps a cross-bucket corpus byte-identical", () => {
    const vault = makeVault("off", SILENT);
    seedPair(vault);

    const summary = dream(vault, { now: NOW_E2E });

    expect(summary.changed).toBe(false);
    expect(summary.cross_topic_rules).toBeUndefined();
    expect(existsSync(crossTopicLedgerPath(vault))).toBe(false);
    expect(
      readdirSync(join(vault, "Brain", "preferences")).some((f) => f.startsWith("pref-cross-")),
    ).toBe(false);
  });

  test("a dry run plans the promotion but writes nothing", () => {
    const vault = makeVault("dry", ENABLED);
    seedPair(vault);

    const summary = dream(vault, { now: NOW_E2E, dryRun: true });

    expect(summary.changed).toBe(true);
    expect(summary.cross_topic_rules).toEqual([`pref-${expectedSlug("pref-alpha", "pref-beta")}`]);
    expect(summary.dry_run).toBe(true);
    expect(existsSync(crossTopicLedgerPath(vault))).toBe(false);
    expect(
      readdirSync(join(vault, "Brain", "preferences")).some((f) => f.startsWith("pref-cross-")),
    ).toBe(false);
  });

  test("day 2 after the rule confirms plans no second promotion (finding 61)", () => {
    const vault = makeVault("day2", ENABLED);
    seedPair(vault);
    const slug = expectedSlug("pref-alpha", "pref-beta");

    const day1 = dream(vault, { now: NOW_E2E });
    expect(day1.cross_topic_rules).toEqual([`pref-${slug}`]);

    // One applied event auto-confirms the promoted rule overnight.
    const DAY2 = new Date("2026-07-20T10:00:00Z");
    appendApplyEvidence(
      vault,
      {
        pref_id: `pref-${slug}`,
        artifact: "[[Daily/2026.07.20]]",
        result: "applied",
        agent: "test",
      },
      { now: DAY2 },
    );

    const day2 = dream(vault, { now: DAY2 });

    // The rule's own confirmation is the run's change; no second
    // promotion fires on top of it.
    expect(day2.confirmed).toEqual([`pref-${slug}`]);
    expect(day2.cross_topic_rules).toBeUndefined();
    const crossFiles = readdirSync(join(vault, "Brain", "preferences")).filter(
      (f) => f.startsWith("pref-cross-") && f.endsWith(".md"),
    );
    expect(crossFiles).toEqual([`pref-${slug}.md`]);
  });

  test("day-3 membership churn mints no second rule (M8); the summary reads like the budget skip", () => {
    const vault = makeVault("churn", ENABLED);
    seedPair(vault);
    const day1Slug = expectedSlug("pref-alpha", "pref-beta");

    const day1 = dream(vault, { now: NOW_E2E });
    expect(day1.cross_topic_rules).toEqual([`pref-${day1Slug}`]);

    // Gamma joins the cluster before the promoted rule ever confirms
    // (no applied evidence yet, still inside its 14-day trial window).
    // The joined cluster elects under a new content slug; without the
    // guard this pass mints a second live rule with the identical
    // principle while the day-1 rule stays live.
    writePreference(vault, {
      slug: "gamma",
      topic: "Gamma",
      principle: P_ALPHA,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      confirmed_at: "2026-07-17T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence_value: 0,
    });

    const DAY3 = new Date("2026-07-21T10:00:00Z");
    const day3 = dream(vault, { now: DAY3 });

    // The guard's skip discloses on the run summary exactly the way the
    // daily budget's skip does: as the absence of a promotion -
    // `cross_topic_rules` stays absent, nothing counts as created.
    expect(day3.cross_topic_rules).toBeUndefined();
    // Exactly one live rule remains.
    const crossFiles = readdirSync(join(vault, "Brain", "preferences")).filter(
      (f) => f.startsWith("pref-cross-") && f.endsWith(".md"),
    );
    expect(crossFiles).toEqual([`pref-${day1Slug}.md`]);
    // And nothing was written: the ledger still carries only day 1's stamp.
    expect(readCrossTopicLedger(vault)?.last_promoted).toEqual({ "": "2026-07-19" });
  });

  test("the rule's provenance and lineage survive its first counter change (finding 77)", () => {
    const vault = makeVault("lineage", ENABLED);
    seedPair(vault);
    const slug = expectedSlug("pref-alpha", "pref-beta");
    const rulePath = join(vault, "Brain", "preferences", `pref-${slug}.md`);

    dream(vault, { now: NOW_E2E });
    const written = parsePreference(rulePath);
    expect(written.provenance).toBe("inferred");
    expect([...(written.related ?? [])]).toEqual(["pref-alpha", "pref-beta"]);

    // The first applied event: applied_count changes, so the refresh
    // update loop rewrites the file.
    const DAY2 = new Date("2026-07-20T10:00:00Z");
    appendApplyEvidence(
      vault,
      {
        pref_id: `pref-${slug}`,
        artifact: "[[Daily/2026.07.20]]",
        result: "applied",
        agent: "test",
      },
      { now: DAY2 },
    );
    dream(vault, { now: DAY2 });

    // The rewrite must carry both fields forward, not wipe them.
    const after = parsePreference(rulePath);
    expect(after.applied_count).toBe(1);
    expect(after.provenance).toBe("inferred");
    expect([...(after.related ?? [])]).toEqual(["pref-alpha", "pref-beta"]);

    // And with both fields carried through the update itself - not merely
    // preserved as file extras the input-driven render can never match -
    // the no-op pre-flight agrees again: a rerun at the same injected now
    // renders the same bytes and changes nothing. (Before the fix the
    // pre-flight render, built without provenance/related, could never
    // match the written file, so every later pass rewrote the rule.)
    const rerun = dream(vault, { now: DAY2 });
    expect(rerun.changed).toBe(false);
  });

  test("min_topics: 1 cannot promote a singleton and the clamp is disclosed (finding 62)", () => {
    const vault = makeVault(
      "floored",
      "schema_version: 1\ncross_topic:\n  enabled: true\n  min_topics: 1\n",
    );
    // A single confirmed preference: under the declared knob this elects
    // as a one-bucket "cross-topic" cluster citing one source.
    writePreference(vault, {
      slug: "alpha",
      topic: "Alpha",
      principle: P_ALPHA,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      confirmed_at: "2026-07-17T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence_value: 0,
    });

    const summary = dream(vault, { now: NOW_E2E });

    expect(summary.changed).toBe(false);
    expect(summary.cross_topic_rules).toBeUndefined();
    expect(existsSync(crossTopicLedgerPath(vault))).toBe(false);
    const clamp = summary.warnings.find((w) => w.code === "cross-topic-config-clamped");
    expect(clamp?.message).toContain("cross_topic.min_topics");
    expect(clamp?.message).toContain("2");
  });
});

// ----- Staging surfaces (review finding 65) ---------------------------------
// The summary carried `cross_topic_rules`, but nothing downstream consumed
// it: the stage projection omitted the field, proposals.jsonl had no row,
// the report had no section, and the review preview built would_create from
// new_unconfirmed only - so a cross-topic-only pass read as "Planned
// changes: yes" with nothing created, and stage-vs-apply drift could not
// see WHICH rule the pass would promote.

describe("the staging surfaces see a cross-topic promotion (finding 65)", () => {
  const NOW_STAGED = new Date("2026-07-19T10:00:00Z");
  const ENABLED = "schema_version: 1\ncross_topic:\n  enabled: true\n";

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-cross-topic-stage-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeVault(name: string): string {
    const vault = join(tmp, name);
    bootstrapBrain(vault, {});
    atomicWriteFileSync(brainConfigPath(vault), ENABLED);
    return vault;
  }

  function seedThird(vault: string): void {
    writePreference(vault, {
      slug: "gamma",
      topic: "Gamma",
      principle: P_ALPHA,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      confirmed_at: "2026-07-17T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence_value: 0,
    });
  }

  test("the projection, proposals and report all name the promoted rule", () => {
    const vault = makeVault("projected");
    for (const [slug, topic, principle] of [
      ["alpha", "Alpha", P_ALPHA],
      ["beta", "Beta", P_BETA],
    ] as const) {
      writePreference(vault, {
        slug,
        topic,
        principle,
        created_at: "2026-01-01T00:00:00Z",
        unconfirmed_until: "2026-01-08T00:00:00Z",
        confirmed_at: "2026-07-17T00:00:00Z",
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        evidenced_by: [],
        applied_count: 0,
        violated_count: 0,
        last_evidence_at: null,
        confidence_value: 0,
      });
    }
    const id = `pref-${expectedSlug("pref-alpha", "pref-beta")}`;

    const bundle = stageDream(vault, { now: NOW_STAGED });

    expect(bundle.plan.changed).toBe(true);
    expect(bundle.plan.cross_topic_rules).toEqual([id]);
    expect(bundle.plan.new_unconfirmed).toEqual([]);
    const proposals = readFileSync(join(bundle.dir, "proposals.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(proposals).toContainEqual({ type: "create_preference", id });
    const report = readFileSync(join(bundle.dir, "REPORT.md"), "utf8");
    expect(report).toContain(id);
  });

  test("validate sees a changed promotion between stage and apply", () => {
    const vault = makeVault("drift");
    for (const [slug, topic, principle] of [
      ["alpha", "Alpha", P_ALPHA],
      ["beta", "Beta", P_BETA],
    ] as const) {
      writePreference(vault, {
        slug,
        topic,
        principle,
        created_at: "2026-01-01T00:00:00Z",
        unconfirmed_until: "2026-01-08T00:00:00Z",
        confirmed_at: "2026-07-17T00:00:00Z",
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        evidenced_by: [],
        applied_count: 0,
        violated_count: 0,
        last_evidence_at: null,
        confidence_value: 0,
      });
    }
    const bundle = stageDream(vault, { now: NOW_STAGED });
    expect(bundle.plan.cross_topic_rules).toEqual(
      [expectedSlug("pref-alpha", "pref-beta")].map((s) => `pref-${s}`),
    );

    // A third source lands after staging: the elected cluster grows, so
    // the pass would promote a DIFFERENT rule than the bundle recorded.
    seedThird(vault);

    const validation = validateDreamBundle(vault, bundle.runId, { now: NOW_STAGED });
    expect(validation.valid).toBe(false);
    expect(validation.drift.some((d) => d.startsWith("cross_topic_rules:"))).toBe(true);
  });

  test("the review preview's would_create includes the promoted rule", async () => {
    const vault = makeVault("preview");
    for (const [slug, topic, principle] of [
      ["alpha", "Alpha", P_ALPHA],
      ["beta", "Beta", P_BETA],
    ] as const) {
      writePreference(vault, {
        slug,
        topic,
        principle,
        created_at: "2026-01-01T00:00:00Z",
        unconfirmed_until: "2026-01-08T00:00:00Z",
        confirmed_at: "2026-07-17T00:00:00Z",
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        evidenced_by: [],
        applied_count: 0,
        violated_count: 0,
        last_evidence_at: null,
        confidence_value: 0,
      });
    }

    const report = await buildReviewCandidates(vault, { now: NOW_STAGED });

    expect(report.would_create).toEqual([`pref-${expectedSlug("pref-alpha", "pref-beta")}`]);
    expect(report.would_promote).toEqual([]);
  });
});
