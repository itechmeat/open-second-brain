/**
 * Body-derived event anchor (provenance at the boundary, t_ac1c4176).
 *
 * The anchor ladder resolves ONE event interval per document from its
 * frontmatter, falling back to an ISO token in its body, and records
 * which rung won as a REGISTERED token. These tests pin the ladder, the
 * two forms the design deliberately refuses (slash dates, clock-relative
 * derivations), and the one it deliberately keeps (a future date).
 */

import { test, expect, describe } from "bun:test";

import { extractTemporalConstraints } from "../../../src/core/brain/temporal-extract.ts";
import {
  EVENT_ANCHOR_SOURCE,
  isEventAnchorSource,
  resolveEventAnchor,
} from "../../../src/core/search/event-anchor.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function dayStart(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}
function dayEnd(iso: string): number {
  return dayStart(iso) + DAY_MS - 1;
}

describe("no anchor at all", () => {
  test("a document with neither frontmatter nor a body ISO token has no anchor", () => {
    expect(resolveEventAnchor({}, "Plain prose with no temporal token whatsoever.")).toBeNull();
  });

  test("an empty body and empty frontmatter has no anchor", () => {
    expect(resolveEventAnchor({}, "")).toBeNull();
  });
});

describe("the body rung", () => {
  test("a lone ISO date in the body becomes a day-width window sourced to the body", () => {
    const anchor = resolveEventAnchor({}, "The migration landed on 2026-03-04 after review.");
    expect(anchor).not.toBeNull();
    expect(anchor!.source).toBe(EVENT_ANCHOR_SOURCE.body);
    expect(anchor!.startMs).toBe(dayStart("2026-03-04"));
    expect(anchor!.endMs).toBe(dayEnd("2026-03-04"));
  });

  test("an ISO interval in the body spans day start to day end", () => {
    const anchor = resolveEventAnchor({}, "Window 2026-03-01/2026-03-05 covers the rollout.");
    expect(anchor).not.toBeNull();
    expect(anchor!.source).toBe(EVENT_ANCHOR_SOURCE.body);
    expect(anchor!.startMs).toBe(dayStart("2026-03-01"));
    expect(anchor!.endMs).toBe(dayEnd("2026-03-05"));
  });

  test("a duration anchored to a co-occurring ISO date is content-derived and is kept", () => {
    const anchor = resolveEventAnchor({}, "Valid from 2026-06-01 for P1Y.");
    expect(anchor).not.toBeNull();
    expect(anchor!.startMs).toBe(dayStart("2026-06-01"));
    expect(anchor!.endMs).toBe(dayEnd("2027-06-01"));
  });

  test("an impossible ISO-shaped date yields no anchor", () => {
    expect(resolveEventAnchor({}, "Ticket 2026-02-31 is not a day.")).toBeNull();
  });
});

describe("forms the design refuses", () => {
  test("a slash-formatted date yields no anchor, because resolving it needs a locale", () => {
    expect(resolveEventAnchor({}, "Signed 04/03/2026 in the meeting.")).toBeNull();
    expect(resolveEventAnchor({}, "Signed 2026/03/04 in the meeting.")).toBeNull();
  });

  test("body text in three non-English scripts yields no anchor", () => {
    expect(
      resolveEventAnchor(
        {},
        "Встреча состоялась четвёртого марта две тысячи двадцать шестого года.",
      ),
    ).toBeNull();
    expect(
      resolveEventAnchor({}, "La reunión fue el cuatro de marzo de dos mil veintiséis."),
    ).toBeNull();
    expect(resolveEventAnchor({}, "会议于二零二六年三月四日举行。")).toBeNull();
  });

  test("a clock-relative body derivation yields no anchor, because a stored value derived from a clock drifts", () => {
    const body = "This authorisation runs for P1Y from the moment it was written.";
    // The shared extractor DOES drift for this body: two runs over
    // UNCHANGED content under two clocks disagree.
    const early = extractTemporalConstraints(body, { now: new Date("2001-01-01T00:00:00Z") });
    const late = extractTemporalConstraints(body, { now: new Date("2031-01-01T00:00:00Z") });
    expect(early).not.toEqual(late);
    // So the anchor refuses to materialise it. Both index fastpaths gate
    // on content identity and would correctly decline to recompute a
    // stored value, so a drifting one would age silently forever.
    expect(resolveEventAnchor({}, body)).toBeNull();
  });

  test("the resolved anchor is a pure function of content across repeated runs", () => {
    const frontmatter = { created_at: "2026-03-04" };
    const body = "Renewal cadence P2Y is reviewed alongside 2026-03-04.";
    const first = resolveEventAnchor(frontmatter, body);
    const second = resolveEventAnchor(frontmatter, body);
    expect(second).toEqual(first);
  });
});

describe("a future date is stored, not dropped", () => {
  test("a body date beyond any plausible clock still produces an anchor", () => {
    const anchor = resolveEventAnchor({}, "The embargo lifts on 2099-12-31.");
    expect(anchor).not.toBeNull();
    expect(anchor!.startMs).toBe(dayStart("2099-12-31"));
    expect(anchor!.endMs).toBe(dayEnd("2099-12-31"));
  });

  test("a future frontmatter validity window still produces an anchor", () => {
    const anchor = resolveEventAnchor({ valid_from: "2099-01-01" }, "no body token");
    expect(anchor).not.toBeNull();
    expect(anchor!.startMs).toBe(dayStart("2099-01-01"));
  });
});

describe("the ladder, top rung first", () => {
  const body = "Body token 2020-01-01 sits at the bottom of the ladder.";

  test("valid_from outranks every lower rung and is sourced to the validity window", () => {
    const anchor = resolveEventAnchor(
      {
        valid_from: "2026-05-01",
        valid_until: "2026-05-31",
        created_at: "2024-01-01",
        date: "2023-01-01",
      },
      body,
    );
    expect(anchor).toEqual({
      startMs: dayStart("2026-05-01"),
      endMs: dayEnd("2026-05-31"),
      source: EVENT_ANCHOR_SOURCE.validity,
    });
  });

  test("created_at wins when no validity window is declared", () => {
    const anchor = resolveEventAnchor({ created_at: "2024-02-03", date: "2023-01-01" }, body);
    expect(anchor).toEqual({
      startMs: dayStart("2024-02-03"),
      endMs: dayEnd("2024-02-03"),
      source: EVENT_ANCHOR_SOURCE.createdAt,
    });
  });

  test("date wins when neither validity nor created_at is declared", () => {
    const anchor = resolveEventAnchor({ date: "2023-07-09" }, body);
    expect(anchor).toEqual({
      startMs: dayStart("2023-07-09"),
      endMs: dayEnd("2023-07-09"),
      source: EVENT_ANCHOR_SOURCE.date,
    });
  });

  test("the body rung is reached only when every frontmatter rung is absent", () => {
    const anchor = resolveEventAnchor({}, body);
    expect(anchor).toEqual({
      startMs: dayStart("2020-01-01"),
      endMs: dayEnd("2020-01-01"),
      source: EVENT_ANCHOR_SOURCE.body,
    });
  });

  test("a frontmatter datetime keeps its instant rather than snapping to the day", () => {
    const anchor = resolveEventAnchor({ created_at: "2024-02-03T11:22:33Z" }, body);
    expect(anchor!.startMs).toBe(Date.parse("2024-02-03T11:22:33Z"));
    expect(anchor!.endMs).toBe(Date.parse("2024-02-03T11:22:33Z"));
  });

  test("only valid_until declared still anchors on the validity rung", () => {
    const anchor = resolveEventAnchor({ valid_until: "2026-05-31" }, body);
    expect(anchor).toEqual({
      startMs: null,
      endMs: dayEnd("2026-05-31"),
      source: EVENT_ANCHOR_SOURCE.validity,
    });
  });
});

describe("a declared-but-unreadable rung stops the ladder", () => {
  test("an unparseable valid_from does not fall through to a lower rung", () => {
    expect(
      resolveEventAnchor(
        { valid_from: "sometime last spring", created_at: "2024-01-01" },
        "2020-01-01",
      ),
    ).toBeNull();
  });

  test("an unparseable created_at does not fall through to date or the body", () => {
    expect(
      resolveEventAnchor({ created_at: "not a date", date: "2023-01-01" }, "2020-01-01"),
    ).toBeNull();
  });

  test("an empty created_at is a declaration that cannot be read, not an absence", () => {
    expect(resolveEventAnchor({ created_at: "" }, "2020-01-01")).toBeNull();
  });
});

describe("the source vocabulary is registered", () => {
  test("every ladder rung reports a token the registry recognises", () => {
    const cases = [
      resolveEventAnchor({ valid_from: "2026-05-01" }, ""),
      resolveEventAnchor({ created_at: "2026-05-01" }, ""),
      resolveEventAnchor({ date: "2026-05-01" }, ""),
      resolveEventAnchor({}, "2026-05-01"),
    ];
    expect(cases.every((a) => a !== null)).toBe(true);
    for (const a of cases) expect(isEventAnchorSource(a!.source)).toBe(true);
    expect(new Set(cases.map((a) => a!.source)).size).toBe(4);
  });

  test("the predicate rejects free text", () => {
    expect(isEventAnchorSource("frontmatter")).toBe(false);
    expect(isEventAnchorSource("")).toBe(false);
    expect(isEventAnchorSource(undefined)).toBe(false);
  });
});
