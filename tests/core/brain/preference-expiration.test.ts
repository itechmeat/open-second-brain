/**
 * C5 (t_a82b674e): caller-settable per-memory expiration on preferences.
 *
 * A caller can stamp an explicit `expiration_date` on a preference at
 * write time. The default read/list path silently drops preferences past
 * their date; an opt-in `showExpired` flag re-includes them for audit.
 * Expiration is orthogonal to dream's heuristic retirement — an
 * expired-by-date preference is FILTERED, never moved to `Brain/retired/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parsePreference,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { queryByTopic } from "../../../src/core/brain/query.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-expiry-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: "deploy",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-26T12:00:00Z",
    unconfirmed_until: "2026-06-02T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    pinned: false,
    confidence: BRAIN_CONFIDENCE.low,
    ...overrides,
  };
}

describe("writePreference — expiration_date frontmatter", () => {
  test("stamps expiration_date into the frontmatter when supplied", () => {
    const res = writePreference(vault, basePref("with-expiry", { expiration_date: "2026-07-15" }));
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain("expiration_date: 2026-07-15");
  });

  test("does NOT emit expiration_date when the caller omits it (byte-identical)", () => {
    const res = writePreference(vault, basePref("no-expiry"));
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain("expiration_date");
  });

  test("parsePreference reads the expiration_date back", () => {
    const res = writePreference(vault, basePref("roundtrip", { expiration_date: "2026-07-15" }));
    const parsed = parsePreference(res.path);
    expect(parsed.expiration_date).toBe("2026-07-15");
  });

  test("a preference without an expiration parses with expiration_date undefined", () => {
    const res = writePreference(vault, basePref("no-expiry-parse"));
    const parsed = parsePreference(res.path);
    expect(parsed.expiration_date).toBeUndefined();
  });

  test("rejects an unparseable expiration_date on write", () => {
    expect(() => writePreference(vault, basePref("bad", { expiration_date: "someday" }))).toThrow();
  });
});

describe("queryByTopic — default drops expired, showExpired re-includes", () => {
  const now = new Date("2026-08-01T00:00:00Z");

  function seedExpiredPreference(): void {
    writePreference(vault, basePref("expired-rule", { expiration_date: "2026-07-15" }));
    // A signal so the topic is populated regardless of the preference filter.
    writeSignal(vault, {
      topic: "deploy",
      signal: "positive",
      agent: "tester",
      principle: "use the staging endpoint",
      created_at: "2026-05-01T00:00:00Z",
      date: "2026-05-01",
      slug: "deploy-live",
    });
  }

  test("default query drops a preference past its expiration_date", () => {
    seedExpiredPreference();
    const res = queryByTopic(vault, "deploy", { now });
    expect(res.preference).toBeNull();
  });

  test("showExpired: true re-includes the expired preference (audit path)", () => {
    seedExpiredPreference();
    const res = queryByTopic(vault, "deploy", { now, showExpired: true });
    expect(res.preference).not.toBeNull();
    expect(res.preference?.id).toBe("pref-expired-rule");
  });

  test("a still-live preference is returned by the default query", () => {
    writePreference(vault, basePref("live-rule", { expiration_date: "2026-12-31" }));
    const res = queryByTopic(vault, "deploy", { now });
    expect(res.preference?.id).toBe("pref-live-rule");
  });

  test("an expired preference is FILTERED, not moved to Brain/retired/ (audit trail preserved)", () => {
    seedExpiredPreference();
    // A read that drops the expired preference must not touch disk.
    queryByTopic(vault, "deploy", { now });
    expect(existsSync(join(vault, "Brain", "preferences", "pref-expired-rule.md"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "retired", "ret-expired-rule.md"))).toBe(false);
  });
});
