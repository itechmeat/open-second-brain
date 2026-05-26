/**
 * Frontmatter emission + parse coverage for the two integrity fields
 * added by the brain integrity suite:
 *
 *   - `_revision` (always emitted; defaults to 0 when caller omits)
 *   - `_content_hash` (only emitted when caller supplies one, which
 *     dream does on every promotion to `confirmed`)
 *
 * Round-trip invariant: `parsePreference(writePreference(input))` must
 * surface the same `revision` and `content_hash` values the writer
 * received.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContentHash } from "../../../src/core/brain/content-hash.ts";
import {
  parsePreference,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-integrity-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
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
    created_at: "2026-05-26T12:00:00Z",
    unconfirmed_until: "2026-06-02T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.unconfirmed,
    evidenced_by: [],
    pinned: false,
    confidence: BRAIN_CONFIDENCE.low,
    ...overrides,
  };
}

describe("writePreference - _revision emission", () => {
  test("does NOT emit _revision when caller omits the field (legacy byte-identical)", () => {
    const res = writePreference(vault, basePref("rev-default"));
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain("_revision:");
  });

  test("emits the supplied revision when caller provides one", () => {
    const res = writePreference(
      vault,
      basePref("rev-supplied", { revision: 7 }),
    );
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain("_revision: 7");
  });

  test("parsePreference reads _revision back as a number", () => {
    const res = writePreference(
      vault,
      basePref("rev-roundtrip", { revision: 12 }),
    );
    const parsed = parsePreference(res.path);
    expect(parsed.revision).toBe(12);
  });

  test("parsePreference defaults revision to 0 when the field is absent on disk", () => {
    // Hand-write a frontmatter without _revision to simulate a legacy
    // file - the reader must not crash and must report 0.
    const path = join(vault, "Brain", "preferences", "pref-legacy.md");
    require("node:fs").writeFileSync(
      path,
      `---
kind: brain-preference
id: pref-legacy
created_at: 2026-01-01T00:00:00Z
_confirmed_at: "null"
unconfirmed_until: 2026-01-08T00:00:00Z
tags: [brain, brain/preference, brain/topic/writing]
topic: writing
_status: unconfirmed
principle: legacy principle
_evidenced_by: []
_applied_count: 0
_violated_count: 0
_last_evidence_at: "null"
_confidence: low
_confidence_value: "null"
pinned: false
---
`,
      "utf8",
    );
    const parsed = parsePreference(path);
    expect(parsed.revision).toBe(0);
  });
});

describe("writePreference - _content_hash emission", () => {
  test("does NOT emit _content_hash when caller omits the field", () => {
    const res = writePreference(vault, basePref("hash-absent"));
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain("_content_hash:");
  });

  test("emits the supplied _content_hash verbatim", () => {
    const hash = computeContentHash("Principle for hash-present", undefined);
    const res = writePreference(
      vault,
      basePref("hash-present", {
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        confirmed_at: "2026-05-26T13:00:00Z",
        content_hash: hash,
      }),
    );
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain(`_content_hash: ${hash}`);
  });

  test("parsePreference reads _content_hash back as a string", () => {
    const hash = computeContentHash("Principle for hash-roundtrip", "writing");
    const res = writePreference(
      vault,
      basePref("hash-roundtrip", {
        scope: "writing",
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        confirmed_at: "2026-05-26T13:00:00Z",
        content_hash: hash,
      }),
    );
    const parsed = parsePreference(res.path);
    expect(parsed.content_hash).toBe(hash);
  });

  test("parsePreference leaves content_hash undefined when the field is absent on disk", () => {
    const res = writePreference(vault, basePref("hash-missing"));
    const parsed = parsePreference(res.path);
    expect(parsed.content_hash).toBeUndefined();
  });
});
