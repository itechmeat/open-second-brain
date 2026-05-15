/**
 * Tests for src/core/brain/digest.ts.
 *
 * The digest is a deterministic renderer over Brain state. We exercise
 * each section in isolation, the empty-window collapse, the markdown-vs-JSON
 * parity, the schema shape from §8.2, and the window-filtering edge.
 *
 * Fixtures are hand-built per test for isolation; the `bootstrap` helper
 * makes a vault root with Brain/ subdirs ready for writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderDigest,
  type DigestJson,
} from "../../src/core/brain/digest.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../src/core/brain/preference.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-digest-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
  ]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SINCE = new Date("2026-05-13T20:00:00Z");
const UNTIL = new Date("2026-05-14T20:00:00Z");

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: slug,
    principle: `Principle for ${slug}`,
    created_at: "2026-05-14T10:42:00Z",
    unconfirmed_until: "2026-05-28T10:42:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[sig-${slug}-a]]`, `[[sig-${slug}-b]]`, `[[sig-${slug}-c]]`],
    scope: "writing",
    confirmed_at: null,
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: "low",
    pinned: false,
    ...overrides,
  };
}

describe("empty-window", () => {
  test("collapses to a single-line Markdown notice and reports `empty: true`", () => {
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.empty).toBe(true);
    expect(res.content).toMatch(/^Brain digest — 2026-05-14: no changes\n$/);
  });

  test("JSON form sets `summary.empty: true` and emits empty arrays for all sections", () => {
    const res = renderDigest(tmp, {
      since: SINCE,
      until: UNTIL,
      format: "json",
      now: UNTIL,
    });
    expect(res.empty).toBe(true);
    const parsed = JSON.parse(res.content) as DigestJson;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.window.since).toBe(SINCE.toISOString());
    expect(parsed.window.until).toBe(UNTIL.toISOString());
    expect(parsed.summary.empty).toBe(true);
    expect(parsed.summary.new_unconfirmed_count).toBe(0);
    expect(parsed.summary.confirmed_count).toBe(0);
    expect(parsed.summary.retired_count).toBe(0);
    expect(parsed.summary.confidence_shift_count).toBe(0);
    expect(parsed.summary.contradiction_count).toBe(0);
    expect(parsed.new_unconfirmed).toEqual([]);
    expect(parsed.confirmed).toEqual([]);
    expect(parsed.retired).toEqual([]);
    expect(parsed.confidence_shifts).toEqual([]);
    expect(parsed.contradictions).toEqual([]);
  });
});

describe("New (unconfirmed, in trial) section", () => {
  test("includes unconfirmed prefs created in the window with signal count and trial deadline", () => {
    writePreference(tmp, basePref("no-internal-abbrev"));
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.empty).toBe(false);
    expect(res.content).toContain("## New (unconfirmed, in trial)");
    expect(res.content).toContain(
      "[[pref-no-internal-abbrev]] — writing, 3 signals, trial ends 2026-05-28",
    );
  });

  test("omits unconfirmed prefs created outside the window", () => {
    writePreference(
      tmp,
      basePref("old", { created_at: "2026-04-01T00:00:00Z" }),
    );
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.empty).toBe(true);
    expect(res.content).not.toContain("[[pref-old]]");
  });
});

describe("Confirmed section", () => {
  test("lists confirmed prefs whose confirmed_at lands in the window", () => {
    writePreference(
      tmp,
      basePref("prefer-typed-errors", {
        status: "confirmed",
        confirmed_at: "2026-05-14T11:00:00Z",
        applied_count: 1,
        last_evidence_at: "2026-05-14T11:00:00Z",
      }),
    );
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T11:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-prefer-typed-errors]]",
        artifact: "[[Daily/2026.05.14]]",
        agent: "claude",
        result: "applied",
      },
    });
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.content).toContain("## Confirmed");
    expect(res.content).toContain(
      "[[pref-prefer-typed-errors]] — writing, first applied in [[Daily/2026.05.14]]",
    );
  });
});

describe("Retired section", () => {
  test("lists retired prefs with reason and days_stale for stale-no-evidence", () => {
    const w = writePreference(
      tmp,
      basePref("prefer-bullets-over-prose", {
        status: "confirmed",
        confirmed_at: "2026-02-12T05:00:00Z",
        created_at: "2026-02-12T05:00:00Z",
        last_evidence_at: "2026-02-12T05:00:00Z",
      }),
    );
    moveToRetired(tmp, w.path, "stale-no-evidence", {
      now: new Date("2026-05-14T05:00:00Z"),
      retired_by: "[[Brain/log/2026-05-14]]",
    });
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.content).toContain("## Retired");
    // 2026-02-12 → 2026-05-14 = 91 days.
    expect(res.content).toMatch(
      /\[\[ret-prefer-bullets-over-prose\]\] — writing, stale-no-evidence \(91 days\)/,
    );
  });

  test("non-stale reasons render without the days_stale parenthetical", () => {
    const w = writePreference(tmp, basePref("rebut-me"));
    moveToRetired(tmp, w.path, "rebutted", {
      now: new Date("2026-05-14T05:00:00Z"),
      retired_by: "[[Brain/log/2026-05-14]]",
    });
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.content).toContain("[[ret-rebut-me]] — writing, rebutted");
    expect(res.content).not.toMatch(/rebutted\s*\(\d+ days\)/);
  });
});

describe("Markdown ↔ JSON parity", () => {
  test("a fixture with one of each section type renders consistently across formats", () => {
    // New (unconfirmed) — 'aaa' created in window.
    writePreference(tmp, basePref("aaa"));
    // Confirmed — 'bbb' confirmed in window.
    writePreference(
      tmp,
      basePref("bbb", {
        status: "confirmed",
        confirmed_at: "2026-05-14T11:00:00Z",
        applied_count: 1,
      }),
    );
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T11:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-bbb]]",
        artifact: "[[Daily/2026.05.14]]",
        agent: "claude",
        result: "applied",
      },
    });
    // Retired — 'ccc' moved within window.
    const ccc = writePreference(tmp, basePref("ccc"));
    moveToRetired(tmp, ccc.path, "rebutted", {
      now: new Date("2026-05-14T12:00:00Z"),
      retired_by: "[[Brain/log/2026-05-14]]",
    });

    const md = renderDigest(tmp, { since: SINCE, until: UNTIL });
    const j = renderDigest(tmp, {
      since: SINCE,
      until: UNTIL,
      format: "json",
      now: UNTIL,
    });
    expect(md.empty).toBe(false);
    expect(j.empty).toBe(false);
    const parsed = JSON.parse(j.content) as DigestJson;
    expect(parsed.new_unconfirmed.map((x) => x.id)).toEqual(["pref-aaa"]);
    expect(parsed.confirmed.map((x) => x.id)).toEqual(["pref-bbb"]);
    expect(parsed.retired.map((x) => x.id)).toEqual(["ret-ccc"]);
    // Markdown contains every id too.
    expect(md.content).toContain("[[pref-aaa]]");
    expect(md.content).toContain("[[pref-bbb]]");
    expect(md.content).toContain("[[ret-ccc]]");
  });
});

describe("window filtering", () => {
  test("entries timestamped before `since` are excluded", () => {
    writePreference(
      tmp,
      basePref("before-window", { created_at: "2026-04-01T00:00:00Z" }),
    );
    writePreference(tmp, basePref("inside-window"));
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.content).toContain("[[pref-inside-window]]");
    expect(res.content).not.toContain("[[pref-before-window]]");
  });

  test("the upper bound is exclusive — until timestamp itself is dropped", () => {
    // created_at = until exactly → must be excluded.
    writePreference(
      tmp,
      basePref("on-the-edge", { created_at: UNTIL.toISOString() }),
    );
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    expect(res.empty).toBe(true);
  });
});

describe("graceful degradation for confidence shifts / contradictions", () => {
  test("a dream event without payload data renders empty sections without throwing", () => {
    // A dream event with no `confidence_shifts` / `contradictions`
    // bullets — what Task 3's current iteration may emit. We require
    // the renderer to tolerate it.
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:00:00Z",
      eventType: "dream",
      body: {
        run_id: "dream-2026-05-14-100000",
        input_signals: "3",
        new_unconfirmed: ["[[pref-x]]"],
      },
    });
    const res = renderDigest(tmp, { since: SINCE, until: UNTIL });
    // Empty because no preference exists with matching window dates
    // and no shifts/contradictions in the payload.
    expect(res.empty).toBe(true);
  });

  test("a dream event with confidence_shifts populates the section", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:00:00Z",
      eventType: "dream",
      body: {
        run_id: "dream-2026-05-14-100000",
        confidence_shifts: [
          "[[pref-no-internal-abbrev]] medium -> high (applied: 11, violated: 0)",
        ],
      },
    });
    const res = renderDigest(tmp, {
      since: SINCE,
      until: UNTIL,
      format: "json",
      now: UNTIL,
    });
    const parsed = JSON.parse(res.content) as DigestJson;
    expect(parsed.confidence_shifts).toHaveLength(1);
    expect(parsed.confidence_shifts[0]!.id).toBe("pref-no-internal-abbrev");
    expect(parsed.confidence_shifts[0]!.from).toBe("medium");
    expect(parsed.confidence_shifts[0]!.to).toBe("high");
    expect(parsed.confidence_shifts[0]!.applied_count).toBe(11);
    expect(parsed.confidence_shifts[0]!.violated_count).toBe(0);
  });
});

describe("`empty` flag semantics", () => {
  test("non-empty data yields empty=false; CLI can use this to skip output", () => {
    writePreference(tmp, basePref("alpha"));
    const md = renderDigest(tmp, { since: SINCE, until: UNTIL });
    const js = renderDigest(tmp, {
      since: SINCE,
      until: UNTIL,
      format: "json",
      now: UNTIL,
    });
    expect(md.empty).toBe(false);
    expect(js.empty).toBe(false);
  });

  test("default window is the last 24 hours when `since` is omitted", () => {
    const now = new Date("2026-05-14T20:00:00Z");
    writePreference(
      tmp,
      basePref("recent", { created_at: "2026-05-14T15:00:00Z" }),
    );
    writePreference(
      tmp,
      basePref("old", { created_at: "2026-04-01T00:00:00Z" }),
    );
    const res = renderDigest(tmp, { until: now });
    expect(res.content).toContain("[[pref-recent]]");
    expect(res.content).not.toContain("[[pref-old]]");
  });
});

describe("validation", () => {
  test("rejects `since > until`", () => {
    expect(() =>
      renderDigest(tmp, {
        since: new Date("2026-05-15T00:00:00Z"),
        until: new Date("2026-05-14T00:00:00Z"),
      }),
    ).toThrow(RangeError);
  });
});
