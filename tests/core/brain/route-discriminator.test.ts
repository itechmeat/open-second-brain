/**
 * Route discrimination (signals-that-survive, unit 3).
 *
 * The write router's decision is split into two pure functions: candidate
 * scoring over structural features, and a fixed ordered ladder of rules
 * that fires only when the top two candidates are within the margin. The
 * decision is recorded as a gated continuity record that never carries the
 * fact text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { FAMILY_PATTERNS, type ExtractedFact } from "../../../src/core/brain/fact-extract.ts";
import {
  ROUTE_DISCRIMINATION_MARGIN,
  ROUTE_DISCRIMINATION_RECORD_KIND,
  ROUTE_RULE_IDS,
  ROUTE_SCORE_WEIGHTS,
  anchorsWithin,
  discriminate,
  emitRouteDiscrimination,
  scoreRouteCandidates,
  type RouteCandidate,
  type RouteFeatures,
  type RouteId,
} from "../../../src/core/brain/routing/route-discriminator.ts";

const NOW_ISO = "2026-07-18T12:00:00Z";

function fact(family: RouteId, text: string): ExtractedFact {
  return { family, text, line: 1 };
}

const NEUTRAL_FEATURES: RouteFeatures = {
  spanChars: 12,
  coveredChars: 6,
  longestMatchChars: 6,
  matchCount: 1,
  containedMatchCount: 0,
  anchorCount: 0,
  anchorTotal: 0,
  dedupHit: 0,
  durableSpan: 1,
};

function candidate(
  route: RouteId,
  order: number,
  score: number,
  features: Partial<RouteFeatures> = {},
): RouteCandidate {
  return { route, order, score, features: { ...NEUTRAL_FEATURES, ...features } };
}

describe("scoreRouteCandidates - purity and determinism", () => {
  test("repeated calls on the same input return deep-equal, frozen output", () => {
    const input = fact("url", "https://a.example/x@y.co");
    const first = scoreRouteCandidates(input, { routes: FAMILY_PATTERNS });
    const second = scoreRouteCandidates(input, { routes: FAMILY_PATTERNS });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every((c) => Object.isFrozen(c) && Object.isFrozen(c.features))).toBe(true);
  });

  test("order is deterministic: score descending, then route-table order", () => {
    const candidates = scoreRouteCandidates(fact("url", "https://a.example/x@y.co"), {
      routes: FAMILY_PATTERNS,
    });
    expect(candidates.map((c) => c.route)).toEqual(["url", "email"]);
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1]!;
      const cur = candidates[i]!;
      expect(prev.score > cur.score || (prev.score === cur.score && prev.order < cur.order)).toBe(
        true,
      );
    }
  });

  test("the origin route is always a candidate, even when its pattern no longer matches", () => {
    const candidates = scoreRouteCandidates(fact("quantity", "https://a.example/p"), {
      routes: FAMILY_PATTERNS,
    });
    const quantity = candidates.find((c) => c.route === "quantity");
    expect(quantity).toBeDefined();
    expect(quantity!.features.matchCount).toBe(0);
    expect(quantity!.features.coveredChars).toBe(0);
  });

  test("every feature is a count, an offset or a set membership", () => {
    const candidates = scoreRouteCandidates(fact("url", "https://a.example/x@y.co"), {
      routes: FAMILY_PATTERNS,
      dedupedRoutes: new Set<RouteId>(["email"]),
    });
    for (const c of candidates) {
      for (const value of Object.values(c.features)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect([0, 1]).toContain(c.features.dedupHit);
      expect([0, 1]).toContain(c.features.durableSpan);
    }
    expect(candidates.find((c) => c.route === "email")!.features.dedupHit).toBe(1);
  });
});

describe("scoreRouteCandidates - structure, not language", () => {
  test("the same structure scores identically in any script", () => {
    const latin = scoreRouteCandidates(fact("url", "https://a.example/uno1"), {
      routes: FAMILY_PATTERNS,
    });
    const cyrillic = scoreRouteCandidates(fact("url", "https://a.example/один"), {
      routes: FAMILY_PATTERNS,
    });
    const japanese = scoreRouteCandidates(fact("url", "https://a.example/イロハニ"), {
      routes: FAMILY_PATTERNS,
    });
    expect(cyrillic).toEqual(latin);
    expect(japanese).toEqual(latin);
  });

  test("anchors are registry forms, not a word list: a non-Latin form anchors", () => {
    const anchors = [{ id: "ent-orgs-privet", forms: ["привет"] }];
    expect(anchorsWithin(anchors, "https://a.example/привет")).toEqual(["ent-orgs-privet"]);
    expect(anchorsWithin(anchors, "https://a.example/hello")).toEqual([]);
  });
});

describe("discriminate - the margin", () => {
  test("does not fire when the top two are further apart than the margin", () => {
    const spread = ROUTE_DISCRIMINATION_MARGIN + 0.001;
    expect(discriminate([candidate("url", 0, 80), candidate("email", 1, 80 - spread)])).toBeNull();
  });

  test("fires at exactly the margin", () => {
    const decision = discriminate([
      candidate("url", 0, 80),
      candidate("email", 1, 80 - ROUTE_DISCRIMINATION_MARGIN),
    ]);
    expect(decision).not.toBeNull();
    expect(decision!.margin).toBe(ROUTE_DISCRIMINATION_MARGIN);
  });

  test("does not fire on a single candidate", () => {
    expect(discriminate([candidate("url", 0, 80)])).toBeNull();
  });
});

describe("discriminate - the rule ladder", () => {
  test("every rule id is stable, unique, and the terminal rule is last", () => {
    expect(Object.isFrozen(ROUTE_RULE_IDS)).toBe(true);
    expect(new Set(ROUTE_RULE_IDS).size).toBe(ROUTE_RULE_IDS.length);
    expect(ROUTE_RULE_IDS).toEqual([
      "overlap-containment",
      "anchor-majority",
      "span-coverage",
      "durable-span",
      "dedup-continuity",
      "family-table-order",
    ]);
  });

  test("overlap-containment prefers the candidate no other candidate contains", () => {
    const decision = discriminate([
      candidate("url", 0, 80, { containedMatchCount: 1, matchCount: 1 }),
      candidate("email", 1, 80, { containedMatchCount: 0, matchCount: 1 }),
    ]);
    expect(decision!.route).toBe("email");
    expect(decision!.rule).toBe("overlap-containment");
  });

  test("anchor-majority decides when containment ties", () => {
    const decision = discriminate([
      candidate("url", 0, 80, { anchorCount: 0 }),
      candidate("email", 1, 80, { anchorCount: 2 }),
    ]);
    expect(decision!.route).toBe("email");
    expect(decision!.rule).toBe("anchor-majority");
  });

  test("span-coverage decides when containment and anchors tie", () => {
    const decision = discriminate([
      candidate("url", 0, 80, { coveredChars: 6 }),
      candidate("email", 1, 80, { coveredChars: 9 }),
    ]);
    expect(decision!.route).toBe("email");
    expect(decision!.rule).toBe("span-coverage");
  });

  test("durable-span decides when coverage ties", () => {
    const decision = discriminate([
      candidate("url", 0, 80, { durableSpan: 0 }),
      candidate("email", 1, 80, { durableSpan: 1 }),
    ]);
    expect(decision!.route).toBe("email");
    expect(decision!.rule).toBe("durable-span");
  });

  test("dedup-continuity decides when durability ties", () => {
    const decision = discriminate([
      candidate("url", 0, 80, { dedupHit: 0 }),
      candidate("email", 1, 80, { dedupHit: 1 }),
    ]);
    expect(decision!.route).toBe("email");
    expect(decision!.rule).toBe("dedup-continuity");
  });

  test("the terminal rule reproduces family-table order and always decides", () => {
    const decision = discriminate([candidate("email", 1, 80), candidate("url", 0, 80)]);
    expect(decision!.route).toBe("url");
    expect(decision!.rule).toBe("family-table-order");
    expect(decision!.candidates.map((c) => c.route)).toEqual(["email", "url"]);
  });

  test("a candidate outside the margin never wins a rule", () => {
    // `email` is inside the band and would win overlap-containment;
    // `quantity` is outside it and must not participate at all.
    const decision = discriminate([
      candidate("url", 0, 80, { containedMatchCount: 1, matchCount: 1 }),
      candidate("email", 1, 80 - ROUTE_DISCRIMINATION_MARGIN, { containedMatchCount: 0 }),
      candidate("quantity", 2, 10, { containedMatchCount: 0 }),
    ]);
    expect(decision!.route).toBe("email");
  });
});

describe("route scoring weights", () => {
  test("the non-structural weights together cannot exceed the margin", () => {
    // A route captured for its own span always attains full coverage, the
    // longest match, and no containment. Bounding the remaining weights by
    // the margin keeps every route change inside the recorded band.
    const soft =
      ROUTE_SCORE_WEIGHTS.entityAnchor +
      ROUTE_SCORE_WEIGHTS.dedupHistory +
      ROUTE_SCORE_WEIGHTS.durableSpan;
    expect(soft).toBeLessThanOrEqual(ROUTE_DISCRIMINATION_MARGIN);
    expect(ROUTE_SCORE_WEIGHTS.containmentPenalty).toBeLessThan(0);
  });
});

describe("emitRouteDiscrimination", () => {
  let vault: string;
  let configHome: string;

  const DECISION = {
    route: "url" as RouteId,
    rule: "family-table-order" as const,
    margin: 0,
    candidates: [candidate("url", 0, 39.231), candidate("email", 1, 39.231)],
  };

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-route-discriminator-vault-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-route-discriminator-cfg-"));
    const configPath = join(configHome, "config.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  });

  test("gate off writes nothing and returns null", () => {
    const input = { createdAt: NOW_ISO, origin: "email" as RouteId, decision: DECISION };
    expect(emitRouteDiscrimination(vault, input, false)).toBeNull();
    expect(emitRouteDiscrimination(vault, input, undefined)).toBeNull();
    expect(emitRouteDiscrimination(vault, input, null)).toBeNull();
    expect(listContinuityRecords(vault, { kind: ROUTE_DISCRIMINATION_RECORD_KIND })).toHaveLength(
      0,
    );
  });

  test("gate on writes one record carrying candidates, scores, margin, winner and rule", () => {
    const record = emitRouteDiscrimination(
      vault,
      { createdAt: NOW_ISO, origin: "email", decision: DECISION },
      true,
    );
    expect(record).not.toBeNull();
    expect(record!.kind).toBe(ROUTE_DISCRIMINATION_RECORD_KIND);
    expect(record!.payload).toEqual({
      origin: "email",
      route: "url",
      rule: "family-table-order",
      margin: 0,
      candidates: [
        { route: "url", score: 39.231 },
        { route: "email", score: 39.231 },
      ],
    });
    expect(listContinuityRecords(vault, { kind: ROUTE_DISCRIMINATION_RECORD_KIND })).toHaveLength(
      1,
    );
  });

  test("fail-open: an unwritable continuity store never throws and returns null", () => {
    // The record shard cannot be created when the log directory is a file.
    rmSync(join(vault, "Brain", "log"), { recursive: true, force: true });
    atomicWriteFileSync(join(vault, "Brain", "log"), "not a directory\n");
    const input = { createdAt: NOW_ISO, origin: "email" as RouteId, decision: DECISION };
    expect(() => emitRouteDiscrimination(vault, input, true)).not.toThrow();
    expect(emitRouteDiscrimination(vault, input, true)).toBeNull();
  });
});
