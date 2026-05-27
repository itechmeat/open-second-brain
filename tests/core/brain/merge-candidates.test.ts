/**
 * Tests for the read-only `findMergeCandidates` detector that feeds
 * the `## Merge suggestions` digest section and the `o2b brain merge`
 * CLI. Fixtures are built via the canonical `writePreference` writer
 * so the on-disk shape stays in lockstep with production output.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findMergeCandidates,
  JACCARD_MERGE_SUGGEST_THRESHOLD,
  MERGE_SUGGESTION_LIMIT,
} from "../../../src/core/brain/merge-candidates.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-merge-cand-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

interface MakePrefOpts {
  readonly slug: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope?: string;
  readonly status?:
    | typeof BRAIN_PREFERENCE_STATUS.unconfirmed
    | typeof BRAIN_PREFERENCE_STATUS.confirmed
    | typeof BRAIN_PREFERENCE_STATUS.quarantine;
}

function makePref(opts: MakePrefOpts): void {
  const status = opts.status ?? BRAIN_PREFERENCE_STATUS.confirmed;
  writePreference(vault, {
    slug: opts.slug,
    topic: opts.topic,
    principle: opts.principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status,
    evidenced_by: [`[[sig-2026-05-01-${opts.slug}]]`],
    confirmed_at: status === BRAIN_PREFERENCE_STATUS.unconfirmed ? null : "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
}

describe("findMergeCandidates", () => {
  test("empty Brain → empty result", () => {
    expect(findMergeCandidates(vault)).toEqual([]);
  });

  test("pair in [threshold, 1) within same (topic, scope) surfaces", () => {
    makePref({
      slug: "imperative-commits",
      topic: "commits",
      principle: "Use imperative voice in commit subjects",
    });
    makePref({
      slug: "imperative-subjects",
      topic: "commits",
      principle: "Write commit subjects in imperative voice",
    });
    const out = findMergeCandidates(vault);
    expect(out.length).toBe(1);
    expect(out[0]!.topic).toBe("commits");
    expect(out[0]!.scope).toBeNull();
    expect(out[0]!.jaccard).toBeGreaterThanOrEqual(JACCARD_MERGE_SUGGEST_THRESHOLD);
    // Ids stored as lexicographically smaller / larger.
    expect(out[0]!.a < out[0]!.b).toBe(true);
  });

  test("pair below threshold does not surface", () => {
    makePref({
      slug: "imperative-commits",
      topic: "commits",
      principle: "Use imperative voice in commit subjects",
    });
    makePref({
      slug: "long-bodies",
      topic: "commits",
      principle: "Wrap message body at seventy two columns please",
    });
    expect(findMergeCandidates(vault).length).toBe(0);
  });

  test("pairs across different topics do not surface", () => {
    makePref({
      slug: "a",
      topic: "x",
      principle: "alpha beta gamma delta",
    });
    makePref({
      slug: "b",
      topic: "y",
      principle: "alpha beta gamma delta",
    });
    expect(findMergeCandidates(vault).length).toBe(0);
  });

  test("pairs across different scopes do not surface", () => {
    makePref({
      slug: "a",
      topic: "t",
      principle: "alpha beta gamma delta",
      scope: "writing",
    });
    makePref({
      slug: "b",
      topic: "t",
      principle: "alpha beta gamma delta",
      scope: "coding",
    });
    expect(findMergeCandidates(vault).length).toBe(0);
  });

  test("unconfirmed prefs are excluded", () => {
    makePref({
      slug: "a",
      topic: "t",
      principle: "alpha beta gamma delta",
      status: BRAIN_PREFERENCE_STATUS.unconfirmed,
    });
    makePref({
      slug: "b",
      topic: "t",
      principle: "alpha beta gamma delta",
    });
    expect(findMergeCandidates(vault).length).toBe(0);
  });

  test("quarantine prefs surface", () => {
    makePref({
      slug: "a",
      topic: "t",
      principle: "alpha beta gamma delta",
      status: BRAIN_PREFERENCE_STATUS.quarantine,
    });
    makePref({
      slug: "b",
      topic: "t",
      principle: "alpha beta gamma delta",
    });
    const out = findMergeCandidates(vault);
    expect(out.length).toBe(1);
  });

  test("stable ordering by (jaccard desc, a asc, b asc)", () => {
    // Three prefs in the same bucket. Pair (a, b) is closest; pair
    // (a, c) and (b, c) share lower similarity. Verify ordering.
    makePref({ slug: "a", topic: "t", principle: "alpha beta gamma delta" });
    makePref({ slug: "b", topic: "t", principle: "alpha beta gamma epsilon" });
    makePref({ slug: "c", topic: "t", principle: "alpha beta zeta eta" });
    const out = findMergeCandidates(vault);
    expect(out.length).toBeGreaterThan(0);
    // First pair must have highest jaccard.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.jaccard).toBeLessThanOrEqual(out[i - 1]!.jaccard);
    }
    // Tie-break: a-id then b-id ascending. Verify by checking the
    // smaller a comes first when jaccards are equal.
    for (let i = 1; i < out.length; i++) {
      if (out[i]!.jaccard === out[i - 1]!.jaccard) {
        if (out[i]!.a !== out[i - 1]!.a) {
          expect(out[i - 1]!.a.localeCompare(out[i]!.a)).toBeLessThan(0);
        } else {
          expect(out[i - 1]!.b.localeCompare(out[i]!.b)).toBeLessThan(0);
        }
      }
    }
  });

  test("limit truncates at MERGE_SUGGESTION_LIMIT", () => {
    // Build 6 near-identical confirmed prefs in one bucket — yields
    // 15 pairs, well above the default limit of 10.
    for (let i = 0; i < 6; i++) {
      makePref({
        slug: `dup-${i}`,
        topic: "t",
        principle: "alpha beta gamma delta epsilon zeta eta theta",
      });
    }
    const out = findMergeCandidates(vault);
    expect(out.length).toBe(MERGE_SUGGESTION_LIMIT);
  });
});
