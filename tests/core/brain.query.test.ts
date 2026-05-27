/**
 * Tests for src/core/brain/query.ts.
 *
 * The query helpers are read-only aggregators over Brain state. We
 * exercise them against a hand-built vault that combines:
 *   - signals in inbox/ and inbox/processed/
 *   - one active preference + one retired preference (same topic)
 *   - log entries (`apply-evidence`, `promote`, `retire`)
 *
 * Each test creates a fresh tmpdir so cleanup is hermetic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../src/core/brain/paths.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { moveToRetired, writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  BrainNotFoundError,
  queryByLogSince,
  queryByPreference,
  queryByTopic,
} from "../../src/core/brain/query.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-query-"));
  // Pre-create the directory tree so writeSignal et al. find their
  // targets. brainDirs() returns absolute paths under <tmp>/Brain/.
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

function basePref(slug: string) {
  return {
    slug,
    topic: slug,
    principle: `Principle for ${slug}`,
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed" as const,
    evidenced_by: [`[[sig-2026-05-13-${slug}]]`, `[[sig-2026-05-14-${slug}]]`],
    scope: "writing",
    confirmed_at: null,
  };
}

describe("queryByPreference", () => {
  test("returns the preference and its applied-evidence trail in chronological order", () => {
    writePreference(tmp, basePref("alpha"));
    // Three apply-evidence entries on different days; the function
    // sorts by timestamp ascending regardless of write order.
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T18:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-alpha]]",
        artifact: "[[Daily/2026.05.14]]",
        agent: "claude",
        result: "applied",
      },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T12:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-alpha]]",
        artifact: "[[Daily/2026.05.14-early]]",
        agent: "claude",
        result: "applied",
      },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-15T08:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-alpha]]",
        artifact: "[[Daily/2026.05.15]]",
        agent: "codex",
        result: "violated",
      },
    });

    const res = queryByPreference(tmp, "pref-alpha");
    expect(res.preference.id).toBe("pref-alpha");
    expect(res.evidence).toHaveLength(3);
    expect(res.evidence.map((e) => e.timestamp)).toEqual([
      "2026-05-14T12:00:00Z",
      "2026-05-14T18:00:00Z",
      "2026-05-15T08:00:00Z",
    ]);
  });

  test("retired preferences are reachable by their `pref-` id (fallback) and by `ret-` id", () => {
    const written = writePreference(tmp, basePref("beta"));
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-beta]]",
        artifact: "[[Daily/2026.05.14]]",
        agent: "claude",
        result: "applied",
      },
    });
    moveToRetired(tmp, written.path, "stale-no-evidence", {
      now: new Date("2026-08-12T05:00:00Z"),
      retired_by: "[[Brain/log/2026-08-12]]",
    });

    // Pref-id fallback to ret-: returns the retired entry.
    const viaPref = queryByPreference(tmp, "pref-beta");
    expect(viaPref.preference.id).toBe("ret-beta");
    expect("retired_at" in viaPref.preference).toBe(true);
    expect(viaPref.evidence).toHaveLength(1);

    // Direct ret-id lookup also resolves.
    const viaRet = queryByPreference(tmp, "ret-beta");
    expect(viaRet.preference.id).toBe("ret-beta");
    expect(viaRet.evidence).toHaveLength(1);
  });

  test("throws BrainNotFoundError when no preference matches", () => {
    expect(() => queryByPreference(tmp, "pref-nonexistent")).toThrow(BrainNotFoundError);
    expect(() => queryByPreference(tmp, "garbage")).toThrow(BrainNotFoundError);
    expect(() => queryByPreference(tmp, "")).toThrow(BrainNotFoundError);
  });

  test("rejects path-traversal style ids before forming a filesystem path", () => {
    // Without slug-shape validation, `pref-../../etc/passwd` would form
    // `<dirs.preferences>/pref-../../etc/passwd.md` and `existsSync`
    // could resolve outside the vault on a permissive filesystem. We
    // surface this as `BrainNotFoundError` so the caller sees the same
    // shape as any other unknown id.
    expect(() => queryByPreference(tmp, "pref-../escape")).toThrow(BrainNotFoundError);
    expect(() => queryByPreference(tmp, "pref-..")).toThrow(BrainNotFoundError);
    expect(() => queryByPreference(tmp, "pref-with/slash")).toThrow(BrainNotFoundError);
    expect(() => queryByPreference(tmp, "ret-../escape")).toThrow(BrainNotFoundError);
  });

  test("preference without any applied evidence still resolves with empty `evidence` array", () => {
    writePreference(tmp, basePref("gamma"));
    const res = queryByPreference(tmp, "pref-gamma");
    expect(res.preference.id).toBe("pref-gamma");
    expect(res.evidence).toEqual([]);
  });
});

describe("queryByTopic", () => {
  test("collects active and processed signals plus the active preference", () => {
    // Two signals — one active, one already processed.
    writeSignal(tmp, {
      topic: "no-internal-abbrev",
      signal: "negative",
      agent: "claude",
      principle: "expand abbreviations",
      created_at: "2026-05-13T10:00:00Z",
      date: "2026-05-13",
      slug: "no-internal-abbrev",
    });
    // Write a "processed" signal directly under inbox/processed/.
    const dirs = brainDirs(tmp);
    writeSignal(tmp, {
      topic: "no-internal-abbrev",
      signal: "negative",
      agent: "claude",
      principle: "expand abbreviations",
      created_at: "2026-05-14T10:00:00Z",
      date: "2026-05-14",
      slug: "no-internal-abbrev",
    });
    // Move the second one to processed/ to simulate dream's effect.
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(
      join(dirs.inbox, "sig-2026-05-14-no-internal-abbrev.md"),
      join(dirs.processed, "sig-2026-05-14-no-internal-abbrev.md"),
    );

    writePreference(tmp, basePref("no-internal-abbrev"));
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T11:00:00Z",
      eventType: "promote",
      body: { preference: "[[pref-no-internal-abbrev]]" },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T15:00:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-no-internal-abbrev]]",
        artifact: "[[Daily/2026.05.14]]",
        agent: "claude",
        result: "applied",
      },
    });

    const res = queryByTopic(tmp, "no-internal-abbrev");
    expect(res.signals).toHaveLength(2);
    expect(res.signals.map((s) => s.id)).toEqual([
      "sig-2026-05-13-no-internal-abbrev",
      "sig-2026-05-14-no-internal-abbrev",
    ]);
    expect(res.preference?.id).toBe("pref-no-internal-abbrev");
    expect(res.all_log_events).toHaveLength(2);
    expect(res.all_log_events.map((e) => e.eventType)).toEqual(["promote", "apply-evidence"]);
  });

  test("falls back to retired preference when no active one exists for the topic", () => {
    const written = writePreference(tmp, basePref("orphan"));
    moveToRetired(tmp, written.path, "rebutted", {
      now: new Date("2026-08-12T05:00:00Z"),
      retired_by: "[[Brain/log/2026-08-12]]",
    });
    const res = queryByTopic(tmp, "orphan");
    expect(res.preference?.id).toBe("ret-orphan");
    expect(res.signals).toEqual([]);
  });

  test("multiple preferences with the same topic resolve deterministically (sorted by filename)", () => {
    // Two active preferences sharing the same topic — pathological but
    // not impossible (e.g. mid-rename, conflict-merge). The query must
    // return the same one every call regardless of readdir order, so
    // tooling that pins on the result stays stable. We pick the
    // lexicographically-smallest filename as the canonical winner.
    writePreference(tmp, { ...basePref("zebra"), slug: "zebra", topic: "shared-topic" });
    writePreference(tmp, { ...basePref("alpha"), slug: "alpha", topic: "shared-topic" });
    writePreference(tmp, { ...basePref("middle"), slug: "middle", topic: "shared-topic" });

    const r1 = queryByTopic(tmp, "shared-topic");
    const r2 = queryByTopic(tmp, "shared-topic");
    const r3 = queryByTopic(tmp, "shared-topic");
    expect(r1.preference?.id).toBe("pref-alpha");
    expect(r2.preference?.id).toBe("pref-alpha");
    expect(r3.preference?.id).toBe("pref-alpha");
  });

  test("unknown topic returns null preference and empty signals/events", () => {
    const res = queryByTopic(tmp, "never-existed");
    expect(res.signals).toEqual([]);
    expect(res.preference).toBeNull();
    expect(res.all_log_events).toEqual([]);
  });
});

describe("queryByLogSince", () => {
  test("returns log entries at or after `since`, in chronological order", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-12T10:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-a]]" },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T14:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-b]]" },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-13T18:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-c]]" },
    });

    const res = queryByLogSince(tmp, new Date("2026-05-13T00:00:00Z"));
    expect(res).toHaveLength(2);
    expect(res.map((e) => e.timestamp)).toEqual(["2026-05-13T18:00:00Z", "2026-05-14T14:00:00Z"]);
  });

  test("invalid Date throws TypeError", () => {
    expect(() => queryByLogSince(tmp, new Date("totally-not-a-date"))).toThrow(TypeError);
  });

  test("empty log returns empty array (no throw)", () => {
    const res = queryByLogSince(tmp, new Date("2026-05-13T00:00:00Z"));
    expect(res).toEqual([]);
  });
});
