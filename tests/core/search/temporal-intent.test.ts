/**
 * Query-side temporal intent (t_58fc4720): a query carrying an explicit
 * time window is detected at the query-plan seam from STRUCTURAL tokens
 * only - ISO date/datetime tokens and the `since:` / `until:` field
 * grammar. No natural-language phrase list, in any language.
 */

import { test, expect, describe } from "bun:test";

import {
  detectTemporalIntent,
  stripTemporalDirectives,
  HISTORICAL_RECENCY_DAMPING,
  HISTORICAL_WINDOW_MIN_AGE_DAYS,
} from "../../../src/core/search/temporal-intent.ts";
import { buildQueryPlan } from "../../../src/core/search/query-plan.ts";
import { SearchError } from "../../../src/core/search/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

describe("detectTemporalIntent (pure)", () => {
  test("a query with no temporal token has no intent", () => {
    expect(detectTemporalIntent("reactor coolant excursion", NOW)).toBeNull();
    expect(detectTemporalIntent("", NOW)).toBeNull();
  });

  test("a bare ISO date resolves to that whole UTC day", () => {
    const intent = detectTemporalIntent("incident 2024-06-15 timeline", NOW);
    expect(intent).not.toBeNull();
    expect(intent!.range.sinceMs).toBe(Date.UTC(2024, 5, 15));
    expect(intent!.range.untilMs).toBe(Date.UTC(2024, 5, 15) + DAY_MS - 1);
    // A bare token is content as well as a signal: it stays in the query.
    expect(stripTemporalDirectives("incident 2024-06-15 timeline")).toBe(
      "incident 2024-06-15 timeline",
    );
  });

  test("a non-Latin-script query with an ISO date is detected identically to the English one", () => {
    // The language-agnostic proof: the same ISO token surrounded by
    // Cyrillic, by Han characters with NO whitespace at all, and by
    // English must produce byte-identical windows.
    const english = detectTemporalIntent("incident 2024-06-15 report", NOW);
    const cyrillic = detectTemporalIntent("инцидент 2024-06-15 отчёт", NOW);
    const han = detectTemporalIntent("事故2024-06-15报告", NOW);
    expect(english).not.toBeNull();
    expect(cyrillic!.range).toEqual(english!.range);
    expect(han!.range).toEqual(english!.range);
    expect(cyrillic!.signature).toBe(english!.signature);
    expect(han!.signature).toBe(english!.signature);
    expect(cyrillic!.historical).toBe(english!.historical);
  });

  test("two ISO tokens span the earliest day-start to the latest day-end", () => {
    const intent = detectTemporalIntent("2024-06-15 through 2024-06-20", NOW)!;
    expect(intent.range.sinceMs).toBe(Date.UTC(2024, 5, 15));
    expect(intent.range.untilMs).toBe(Date.UTC(2024, 5, 20) + DAY_MS - 1);
  });

  test("an ISO datetime token resolves to its exact instant", () => {
    const intent = detectTemporalIntent("deploy 2024-06-15T10:30:00Z rollback", NOW)!;
    expect(intent.range.sinceMs).toBe(Date.UTC(2024, 5, 15, 10, 30, 0));
    expect(intent.range.untilMs).toBe(Date.UTC(2024, 5, 15, 10, 30, 0));
  });

  test("a date-shaped run embedded in a longer digit run is not a date", () => {
    expect(detectTemporalIntent("build 12024-06-155", NOW)).toBeNull();
  });

  test("since: / until: field tokens resolve through the shared time-point parser", () => {
    const intent = detectTemporalIntent("coolant since:2024-06-01 until:2024-06-30", NOW)!;
    expect(intent.range.sinceMs).toBe(Date.UTC(2024, 5, 1));
    expect(intent.range.untilMs).toBe(Date.UTC(2024, 5, 30) + DAY_MS - 1);
  });

  test("a field token is a directive, not content: it is stripped from the query text", () => {
    expect(stripTemporalDirectives("coolant since:2024-06-01 until:2024-06-30")).toBe("coolant");
    expect(stripTemporalDirectives("since:2024-06-01 coolant valve")).toBe("coolant valve");
  });

  test("stripping is byte-identical for a query carrying no directive", () => {
    const untouched = "  reactor   coolant  ";
    expect(stripTemporalDirectives(untouched)).toBe(untouched);
  });

  test("field tokens take precedence over bare ISO tokens in the same query", () => {
    const intent = detectTemporalIntent("since:2024-06-01 incident 2025-01-01", NOW)!;
    expect(intent.range.sinceMs).toBe(Date.UTC(2024, 5, 1));
    expect(intent.range.untilMs).toBeNull();
  });

  test("relative field values resolve against the injected clock, never a wall clock", () => {
    const intent = detectTemporalIntent("coolant since:7d", NOW)!;
    expect(intent.range.sinceMs).toBe(NOW - 7 * DAY_MS);
    expect(intent.range.untilMs).toBeNull();
  });

  test("an open-ended since: window reaches the present and is not historical", () => {
    const intent = detectTemporalIntent("coolant since:7d", NOW)!;
    expect(intent.historical).toBe(false);
    expect(intent.recencyDamping).toBe(1);
  });

  test("a window that closed long ago is historical and damps the freshness prior", () => {
    const intent = detectTemporalIntent("coolant since:2024-06-01 until:2024-06-30", NOW)!;
    expect(intent.historical).toBe(true);
    expect(intent.recencyDamping).toBe(HISTORICAL_RECENCY_DAMPING);
    expect(HISTORICAL_RECENCY_DAMPING).toBeGreaterThan(0);
    expect(HISTORICAL_RECENCY_DAMPING).toBeLessThan(1);
  });

  test("a window closing inside the minimum age is not yet historical", () => {
    const untilMs = NOW - (HISTORICAL_WINDOW_MIN_AGE_DAYS - 1) * DAY_MS;
    const until = new Date(untilMs).toISOString();
    const intent = detectTemporalIntent(`coolant until:${until}`, NOW)!;
    expect(intent.historical).toBe(false);
    expect(intent.recencyDamping).toBe(1);
  });

  test("a malformed field-token value raises the named error, never a silent skip", () => {
    expect(() => detectTemporalIntent("coolant since:notadate", NOW)).toThrow(SearchError);
  });

  test("an inverted field window raises the named error", () => {
    expect(() => detectTemporalIntent("coolant since:2024-06-30 until:2024-06-01", NOW)).toThrow(
      SearchError,
    );
  });

  // ----- a bare token is a shape, not a declaration -----------------------

  test("an ISO-SHAPED but impossible bare token declares nothing and is left alone", () => {
    for (const query of [
      "reactor invoice 2024-06-31",
      "leap day 2023-02-29",
      "ticket 2026-13-45",
      "deploy 2024-06-15T99:99:99Z rollback",
    ]) {
      expect(detectTemporalIntent(query, NOW)).toBeNull();
      expect(stripTemporalDirectives(query)).toBe(query);
    }
  });

  test("a valid bare token beside an impossible one still declares its own window", () => {
    const intent = detectTemporalIntent("invoice 2024-06-31 filed 2024-06-15", NOW)!;
    expect(intent.range.sinceMs).toBe(Date.UTC(2024, 5, 15));
  });

  test("an impossible date in an explicit FIELD token still raises: the operator declared it", () => {
    expect(() => detectTemporalIntent("coolant since:2024-06-31", NOW)).toThrow(SearchError);
    expect(() => detectTemporalIntent("coolant until:2023-02-29", NOW)).toThrow(SearchError);
  });

  // ----- no phrase, in any language, is recognised ------------------------

  test("a natural-language field value is refused in every language alike", () => {
    for (const value of ["yesterday", "today", "ayer", "hoy", "gestern", "昨天"]) {
      expect(() => detectTemporalIntent(`coolant since:${value}`, NOW)).toThrow(SearchError);
    }
  });

  test("the language-neutral field forms are accepted", () => {
    expect(detectTemporalIntent("coolant since:2024-06-01", NOW)).not.toBeNull();
    expect(detectTemporalIntent("coolant since:2024-06-01T10:30:00Z", NOW)).not.toBeNull();
    expect(detectTemporalIntent("coolant since:12h", NOW)).not.toBeNull();
    expect(detectTemporalIntent("coolant since:7d", NOW)).not.toBeNull();
    expect(detectTemporalIntent("coolant until:2w", NOW)).not.toBeNull();
  });

  test("detection is deterministic against a fixed clock", () => {
    expect(detectTemporalIntent("since:2024-06-01 coolant", NOW)).toEqual(
      detectTemporalIntent("since:2024-06-01 coolant", NOW),
    );
  });

  test("the signature is derived from the resolved absolute bounds", () => {
    const a = detectTemporalIntent("2024-06-15", NOW)!;
    const b = detectTemporalIntent("2024-06-16", NOW)!;
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("buildQueryPlan carries the temporal intent", () => {
  test("without an injected clock nothing is detected and the plan is unchanged", () => {
    const plan = buildQueryPlan("coolant since:2024-06-01");
    expect(plan.temporalIntent).toBeUndefined();
  });

  test("a query with no temporal window keeps a byte-identical planHash", () => {
    const withoutClock = buildQueryPlan("reactor coolant excursion");
    const withClock = buildQueryPlan("reactor coolant excursion", [], undefined, undefined, NOW);
    expect(withClock.planHash).toBe(withoutClock.planHash);
    expect(withClock.temporalIntent).toBeUndefined();
    expect(withClock).toEqual(withoutClock);
  });

  test("a temporal window changes the planHash so a cached row is never reused across windows", () => {
    const june = buildQueryPlan("coolant since:2024-06-01", [], undefined, undefined, NOW);
    const july = buildQueryPlan("coolant since:2024-07-01", [], undefined, undefined, NOW);
    const bare = buildQueryPlan("coolant", [], undefined, undefined, NOW);
    expect(june.temporalIntent).toBeDefined();
    expect(june.planHash).not.toBe(july.planHash);
    expect(june.planHash).not.toBe(bare.planHash);
  });

  test("intent classification reads the residual query, not the stripped directive", () => {
    const withDirective = buildQueryPlan("coolant since:2024-06-01", [], undefined, undefined, NOW);
    const residualOnly = buildQueryPlan("coolant", [], undefined, undefined, NOW);
    expect(withDirective.intent).toBe(residualOnly.intent);
    expect(withDirective.weightProfile).toEqual(residualOnly.weightProfile);
  });
});
