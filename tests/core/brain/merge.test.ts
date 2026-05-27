/**
 * Tests for `mergePreferences` — the §12 mutating writer.
 *
 * Fixtures are built via the canonical `writePreference` so the
 * on-disk shape stays in lockstep with production output. Guards
 * are tested by `expect.toThrow(BrainMergeError)` plus a `code`
 * check; the happy path is verified by reading the resulting files
 * back through `parsePreference`/`parseRetired`/`parseLogDay`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenerateActiveQuiet } from "../../../src/core/brain/active.ts";
import { parseLogDay } from "../../../src/core/brain/log.ts";
import { BrainMergeError, mergePreferences } from "../../../src/core/brain/merge.ts";
import {
  parsePreference,
  parseRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "../../../src/core/brain/types.ts";

let vault: string;
const NOW = new Date("2026-05-18T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-merge-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
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
    topic: "commits",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    pinned: false,
    ...overrides,
  };
}

describe("mergePreferences — guards", () => {
  test("rejects when keep id equals drop id", () => {
    writePreference(vault, basePref("a"));
    expect(() => mergePreferences(vault, "pref-a", "pref-a", { now: NOW })).toThrow(
      BrainMergeError,
    );
  });

  test("rejects when keep is missing", () => {
    writePreference(vault, basePref("b"));
    try {
      mergePreferences(vault, "pref-missing", "pref-b", { now: NOW });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainMergeError);
      expect((e as BrainMergeError).code).toBe("keep-not-found");
    }
  });

  test("rejects when drop is missing", () => {
    writePreference(vault, basePref("a"));
    try {
      mergePreferences(vault, "pref-a", "pref-missing", { now: NOW });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainMergeError);
      expect((e as BrainMergeError).code).toBe("drop-not-found");
    }
  });

  test("rejects mismatched topic", () => {
    writePreference(vault, basePref("a", { topic: "x" }));
    writePreference(vault, basePref("b", { topic: "y" }));
    try {
      mergePreferences(vault, "pref-a", "pref-b", { now: NOW });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainMergeError);
      expect((e as BrainMergeError).code).toBe("topic-mismatch");
    }
  });

  test("rejects mismatched scope (string vs null)", () => {
    writePreference(vault, basePref("a", { scope: "writing" }));
    writePreference(vault, basePref("b"));
    try {
      mergePreferences(vault, "pref-a", "pref-b", { now: NOW });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainMergeError);
      expect((e as BrainMergeError).code).toBe("scope-mismatch");
    }
  });

  test("rejects when drop is pinned and keep is not", () => {
    writePreference(vault, basePref("a"));
    writePreference(vault, basePref("b", { pinned: true }));
    try {
      mergePreferences(vault, "pref-a", "pref-b", { now: NOW });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainMergeError);
      expect((e as BrainMergeError).code).toBe("pin-parity");
    }
  });

  test("rejects unconfirmed preferences", () => {
    writePreference(
      vault,
      basePref("a", {
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        confirmed_at: null,
      }),
    );
    writePreference(vault, basePref("b"));
    try {
      mergePreferences(vault, "pref-a", "pref-b", { now: NOW });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainMergeError);
      expect((e as BrainMergeError).code).toBe("unsupported-status");
    }
  });

  test("accepts when both are pinned", () => {
    writePreference(vault, basePref("a", { pinned: true }));
    writePreference(vault, basePref("b", { pinned: true }));
    expect(() => mergePreferences(vault, "pref-a", "pref-b", { now: NOW })).not.toThrow();
  });
});

describe("mergePreferences — happy path", () => {
  test("merges counters, evidenced_by, last_evidence_at; retires drop with merged-into", () => {
    writePreference(
      vault,
      basePref("keep", {
        evidenced_by: ["[[sig-2026-05-01-keep]]", "[[sig-2026-05-02-shared]]"],
        applied_count: 5,
        violated_count: 1,
        last_evidence_at: "2026-05-10T00:00:00Z",
        principle: "Use imperative voice in commit subjects",
      }),
    );
    writePreference(
      vault,
      basePref("drop", {
        evidenced_by: ["[[sig-2026-05-02-shared]]", "[[sig-2026-05-03-drop]]"],
        applied_count: 4,
        violated_count: 0,
        last_evidence_at: "2026-05-12T00:00:00Z",
        principle: "Write commit subjects in imperative voice",
      }),
    );
    regenerateActiveQuiet(vault, { now: NOW });

    const plan = mergePreferences(vault, "pref-keep", "pref-drop", {
      now: NOW,
      agentName: "test-agent",
    });

    expect(plan.keep_id).toBe("pref-keep");
    expect(plan.drop_id).toBe("pref-drop");
    expect(plan.applied_sum).toBe(9);
    expect(plan.violated_sum).toBe(1);
    expect(plan.last_evidence_at).toBe("2026-05-12T00:00:00Z");
    expect(plan.merged_evidenced_by).toEqual([
      "[[sig-2026-05-01-keep]]",
      "[[sig-2026-05-02-shared]]",
      "[[sig-2026-05-03-drop]]",
    ]);

    // Keep is updated on disk.
    const keepPath = join(vault, "Brain", "preferences", "pref-keep.md");
    const keep = parsePreference(keepPath);
    expect(keep.applied_count).toBe(9);
    expect(keep.violated_count).toBe(1);
    expect(keep.last_evidence_at).toBe("2026-05-12T00:00:00Z");
    expect(keep.evidenced_by).toEqual([
      "[[sig-2026-05-01-keep]]",
      "[[sig-2026-05-02-shared]]",
      "[[sig-2026-05-03-drop]]",
    ]);
    // Principle and other identity fields stay on keep.
    expect(keep.principle).toBe("Use imperative voice in commit subjects");

    // Drop is gone from preferences/ and present in retired/ with the
    // merged-into reason and a superseded_by pointing at keep.
    const dropPrefPath = join(vault, "Brain", "preferences", "pref-drop.md");
    expect(existsSync(dropPrefPath)).toBe(false);
    const retiredPath = join(vault, "Brain", "retired", "ret-drop.md");
    const retired = parseRetired(retiredPath);
    expect(retired.retired_reason).toBe(BRAIN_RETIRED_REASON.mergedInto);
    expect(retired.superseded_by).toBeTruthy();
    expect(retired.superseded_by!).toContain("pref-keep");

    // Log carries a `merge` event with both wikilinks plus the
    // summary counters.
    const day = NOW.toISOString().slice(0, 10);
    const { entries } = parseLogDay(vault, day);
    const merges = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.merge);
    expect(merges.length).toBe(1);
    const body = merges[0]!.body;
    expect(String(body["keep"])).toContain("pref-keep");
    expect(String(body["drop"])).toContain("pref-drop");
    expect(String(body["applied_sum"])).toContain("9");
    expect(String(body["agent"])).toBe("test-agent");

    // active.md regenerated — drop is gone, keep is there.
    const activeContent = readFileSync(join(vault, "Brain", "active.md"), "utf8");
    expect(activeContent).toContain("pref-keep");
    expect(activeContent).not.toContain("pref-drop");
  });

  test("dryRun returns plan but writes nothing", () => {
    writePreference(vault, basePref("keep"));
    writePreference(vault, basePref("drop"));
    const before = readFileSync(join(vault, "Brain", "preferences", "pref-keep.md"), "utf8");
    const plan = mergePreferences(vault, "pref-keep", "pref-drop", {
      now: NOW,
      dryRun: true,
    });
    expect(plan.applied_sum).toBe(2);
    // Disk unchanged.
    expect(readFileSync(join(vault, "Brain", "preferences", "pref-keep.md"), "utf8")).toBe(before);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-drop.md"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "retired", "ret-drop.md"))).toBe(false);
  });

  test("preserves keep.pinned across merge", () => {
    writePreference(vault, basePref("keep", { pinned: true }));
    writePreference(vault, basePref("drop", { pinned: true }));
    mergePreferences(vault, "pref-keep", "pref-drop", { now: NOW });
    const keep = parsePreference(join(vault, "Brain", "preferences", "pref-keep.md"));
    expect(keep.pinned).toBe(true);
  });
});
