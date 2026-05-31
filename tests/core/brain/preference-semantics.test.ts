import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  moveToRetired,
  parsePreference,
  parseRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-semantics-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
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
    topic: "writing",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-30T12:00:00Z",
    unconfirmed_until: "2026-06-06T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-30T13:00:00Z",
    pinned: false,
    confidence: BRAIN_CONFIDENCE.low,
    ...overrides,
  };
}

describe("preference memory semantics frontmatter", () => {
  test("writePreference omits semantics metadata unless supplied", () => {
    const res = writePreference(vault, basePref("legacy"));
    const text = readFileSync(res.path, "utf8");

    expect(text).not.toContain("memory_layer:");
    expect(text).not.toContain("memory_branch:");
    expect(text).not.toContain("depends_on:");
    expect(text).not.toContain("refines:");
  });

  test("writePreference emits supplied layer, branch, and relation fields", () => {
    const res = writePreference(
      vault,
      basePref("semantic", {
        memory_layer: "L2",
        memory_branch: "research",
        depends_on: ["[[pref-base]]"],
        refines: ["[[pref-draft]]"],
      } as Partial<WritePreferenceInput>),
    );
    const text = readFileSync(res.path, "utf8");

    expect(text).toContain("memory_layer: L2");
    expect(text).toContain("memory_branch: research");
    expect(text).toContain('depends_on: ["[[pref-base]]"]');
    expect(text).toContain('refines: ["[[pref-draft]]"]');
  });

  test("parsePreference round-trips supplied semantics metadata", () => {
    const res = writePreference(
      vault,
      basePref("roundtrip", {
        memory_layer: "L3",
        memory_branch: "persona",
        depends_on: ["[[pref-base]]"],
        refines: ["[[pref-draft]]"],
        contradicts: ["[[pref-old]]"],
      } as Partial<WritePreferenceInput>),
    );

    const parsed = parsePreference(res.path);
    expect(parsed.memory_layer).toBe("L3");
    expect(parsed.memory_branch).toBe("persona");
    expect(parsed.depends_on).toEqual(["[[pref-base]]"]);
    expect(parsed.refines).toEqual(["[[pref-draft]]"]);
    expect(parsed.contradicts).toEqual(["[[pref-old]]"]);
  });

  test("parsePreference rejects invalid memory_layer values", () => {
    const path = join(vault, "Brain", "preferences", "pref-invalid-layer.md");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-invalid-layer",
        "created_at: 2026-05-30T12:00:00Z",
        "_confirmed_at: 2026-05-30T13:00:00Z",
        "unconfirmed_until: 2026-06-06T12:00:00Z",
        "tags: [brain, brain/preference, brain/topic/writing]",
        "topic: writing",
        "_status: confirmed",
        "principle: invalid layer",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        '_last_evidence_at: "null"',
        "_confidence: low",
        '_confidence_value: "null"',
        "pinned: false",
        "memory_layer: L9",
        "---",
      ].join("\n"),
      "utf8",
    );

    expect(() => parsePreference(path)).toThrow("memory_layer");
  });

  test("writePreference rejects invalid memory_branch slugs", () => {
    expect(() =>
      writePreference(
        vault,
        basePref("bad-branch", {
          memory_branch: "../research",
        } as Partial<WritePreferenceInput>),
      ),
    ).toThrow("memory_branch");
  });

  test("moveToRetired preserves memory semantics metadata", () => {
    const res = writePreference(
      vault,
      basePref("retire-me", {
        memory_layer: "L1",
        memory_branch: "experiment",
        depends_on: ["[[pref-base]]"],
      } as Partial<WritePreferenceInput>),
    );

    const retired = moveToRetired(vault, res.path, BRAIN_RETIRED_REASON.userRejected, {
      now: new Date("2026-06-01T00:00:00Z"),
      retired_by: "[[Brain/log/2026-06-01]]",
      user_rejected_reason: "test",
    });

    const parsed = parseRetired(retired.path);
    expect(parsed.memory_layer).toBe("L1");
    expect(parsed.memory_branch).toBe("experiment");
    expect(parsed.depends_on).toEqual(["[[pref-base]]"]);
  });
});
