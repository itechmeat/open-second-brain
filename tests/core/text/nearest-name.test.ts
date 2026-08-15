/**
 * Nearest-name suggestion (evidence-at-the-boundary, task C3).
 *
 * The argument gate is only useful if the suggestion it prints is the one
 * the caller meant, and only trustworthy if two callers who send the same
 * typo against the same schema get the same answer. Both properties are
 * asserted here: the distance is pure string distance, and the tie-break
 * is a total order over the candidate names rather than their iteration
 * order.
 */

import { describe, expect, test } from "bun:test";

import {
  editDistance,
  nearestName,
  NEAREST_NAME_MAX_DISTANCE_RATIO,
  NEAREST_NAME_MAX_TARGET_LENGTH,
} from "../../../src/core/text/nearest-name.ts";

/**
 * `nearestName` with neither length bound: every candidate is measured,
 * however long the target is. The bounds under test must agree with this
 * on every name a caller could plausibly mistype, which is what makes
 * them an early-out rather than a change of behaviour.
 */
function unboundedNearestName(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(target, candidate);
    if (distance > Math.max(target.length, candidate.length) * NEAREST_NAME_MAX_DISTANCE_RATIO) {
      continue;
    }
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

describe("editDistance", () => {
  test("an identical pair is zero and an empty pair is zero", () => {
    expect(editDistance("query", "query")).toBe(0);
    expect(editDistance("", "")).toBe(0);
  });

  test("an empty string costs one edit per character of the other", () => {
    expect(editDistance("", "limit")).toBe(5);
    expect(editDistance("limit", "")).toBe(5);
  });

  test("one insertion, one deletion and one substitution each cost one", () => {
    expect(editDistance("query", "queryy")).toBe(1);
    expect(editDistance("quiery", "query")).toBe(1);
    expect(editDistance("query", "queay")).toBe(1);
  });

  test("one adjacent transposition costs one, not two", () => {
    // The most common typo class. Levenshtein charges two edits for it,
    // which pushes `qeury` past the suggestion threshold; the restricted
    // Damerau variant charges one and keeps the suggestion reachable.
    expect(editDistance("qeury", "query")).toBe(1);
  });

  test("it is symmetric", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["session_id", "sesion_id"],
      ["path_prefix", "prefix_path"],
      ["a", "abcdef"],
    ];
    for (const [left, right] of pairs) {
      expect(editDistance(left, right), `${left}/${right}`).toBe(editDistance(right, left));
    }
  });

  test("unrelated names cost at most the longer length", () => {
    expect(editDistance("foo", "bar")).toBe(3);
    expect(editDistance("query", "telemetry_host")).toBeLessThanOrEqual(14);
  });
});

describe("nearestName", () => {
  test("a one-edit typo against a real schema name is suggested", () => {
    expect(nearestName("quiery", ["query", "limit", "semantic"])).toBe("query");
    expect(nearestName("sesion_id", ["session_id", "turn_id"])).toBe("session_id");
  });

  test("an exact match is its own nearest name", () => {
    expect(nearestName("limit", ["query", "limit"])).toBe("limit");
  });

  test("nothing within the threshold yields no suggestion at all", () => {
    // A wrong guess is worse than silence: the gate says "no close match"
    // rather than pointing the caller at an unrelated parameter.
    expect(nearestName("zzzzzzzz", ["query", "limit", "semantic"])).toBeUndefined();
    expect(nearestName("query", [])).toBeUndefined();
  });

  test("the threshold is a declared ratio, not a hidden literal", () => {
    expect(NEAREST_NAME_MAX_DISTANCE_RATIO).toBeGreaterThan(0);
    expect(NEAREST_NAME_MAX_DISTANCE_RATIO).toBeLessThan(1);
  });

  test("a short name admits no typo, because one edit is most of it", () => {
    expect(nearestName("j", ["k", "id"])).toBeUndefined();
  });

  test("ties break on the name, not on the caller's ordering", () => {
    // "bat" is one edit from all three. Every permutation must answer
    // with the same candidate or the error message is nondeterministic.
    const candidates = ["cat", "bad", "bar"];
    const permutations = [
      ["cat", "bad", "bar"],
      ["bar", "cat", "bad"],
      ["bad", "bar", "cat"],
      ["cat", "bar", "bad"],
      ["bar", "bad", "cat"],
      ["bad", "cat", "bar"],
    ];
    for (const permutation of permutations) {
      expect(nearestName("bat", permutation), permutation.join(",")).toBe("bad");
    }
    expect(new Set(candidates).size).toBe(3);
  });

  test("a nearer candidate wins over an earlier one", () => {
    expect(nearestName("querx", ["aquery", "query"])).toBe("query");
  });

  test("duplicate candidates do not change the answer", () => {
    expect(nearestName("quiery", ["query", "query", "limit"])).toBe("query");
  });
});

describe("the length bounds", () => {
  /** A closed tool schema's worth of declared names, at realistic lengths. */
  const SCHEMA_NAMES: ReadonlyArray<string> = Object.freeze([
    "query",
    "limit",
    "semantic",
    "session_id",
    "turn_id",
    "path_prefix",
    "telemetry_host",
    "modeled_tokens_per_inference",
  ]);

  test("a pathological argument name is refused promptly and suggests nothing", () => {
    // The request-path reproduction: one `tools/call` carrying a single
    // 1 MB argument key. Unbounded, the edit-distance walk is
    // O(len(name) x len(candidate)) against every declared property and
    // blocks the event loop for over ten seconds - inside the HTTP
    // transport's 1 MB body cap, and with no cap at all on stdio.
    const pathological = "a".repeat(1_000_000);
    const started = performance.now();
    const answer = nearestName(pathological, SCHEMA_NAMES);
    const elapsedMs = performance.now() - started;
    expect(answer).toBeUndefined();
    expect(elapsedMs).toBeLessThan(100);
  });

  test("the bounds change no answer for names a caller could plausibly mistype", () => {
    // The early-out is exact, not an approximation: edit distance is at
    // least the difference in length, so a candidate the bound skips
    // could never have come within the threshold anyway.
    const targets: ReadonlyArray<string> = [
      ...SCHEMA_NAMES,
      "quiery",
      "qeury",
      "querx",
      "sesion_id",
      "turnid",
      "path-prefix",
      "pathprefix",
      "telemetry_hosts",
      "modeled_tokens_per_inferenc",
      "modeled_tokens_per_inferences",
      "s",
      "",
      "wombat",
      "zzzzzzzz",
      "session",
      "session_identifier",
      "a".repeat(NEAREST_NAME_MAX_TARGET_LENGTH),
    ];
    for (const target of targets) {
      expect(nearestName(target, SCHEMA_NAMES), target).toBe(
        unboundedNearestName(target, SCHEMA_NAMES),
      );
    }
  });

  test("the target cap sits far above the longest name any schema declares", () => {
    // 28 characters is the longest declared property name on this server,
    // and at the ratio above a candidate must be at least two thirds of
    // the target's length to be reachable at all.
    const longestDeclared = SCHEMA_NAMES.map((name) => name.length).reduce((a, b) =>
      Math.max(a, b),
    );
    expect(longestDeclared).toBeLessThan(NEAREST_NAME_MAX_TARGET_LENGTH);
    expect(NEAREST_NAME_MAX_TARGET_LENGTH * (1 - NEAREST_NAME_MAX_DISTANCE_RATIO)).toBeGreaterThan(
      longestDeclared,
    );
  });
});
