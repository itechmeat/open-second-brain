/**
 * Coverage for the per-page `_lifecycle` frontmatter emission added
 * in v0.10.15. Default-case absence is the backwards-compat anchor:
 * callers that do not supply `lifecycle` keep producing byte-identical
 * output so existing fixtures and tests stay green.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parsePreference,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { readLifecycle } from "../../../src/core/brain/page-meta/lifecycle.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-lifecycle-"));
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

describe("writePreference — _lifecycle emission", () => {
  test("does NOT emit _lifecycle when caller omits the field", () => {
    const res = writePreference(vault, basePref("legacy"));
    const yaml = readFileSync(res.path, "utf8");
    expect(yaml).not.toContain("_lifecycle:");
    expect(yaml).not.toContain("lifecycle:");
  });

  test("emits _lifecycle when caller supplies it", () => {
    const res = writePreference(vault, basePref("modern", { lifecycle: "verified" }));
    const yaml = readFileSync(res.path, "utf8");
    expect(yaml).toContain("_lifecycle: verified");
  });

  test("default lifecycle for parsed legacy file is stable (via readLifecycle)", () => {
    const res = writePreference(vault, basePref("legacy2"));
    const pref = parsePreference(res.path);
    expect(pref).toBeDefined();
    // Confirm the actual default contract: the read-side helper
    // returns `stable` when the field is absent on disk.
    const [meta] = parseFrontmatter(res.path);
    expect(readLifecycle(meta)).toBe("stable");
    const yaml = readFileSync(res.path, "utf8");
    expect(yaml).not.toMatch(/^_lifecycle:/m);
  });

  test("byte-identical second write when lifecycle is omitted both times", () => {
    const res = writePreference(vault, basePref("idem"));
    const first = readFileSync(res.path, "utf8");
    writePreference(vault, basePref("idem"), { overwrite: true });
    const second = readFileSync(res.path, "utf8");
    expect(second).toBe(first);
  });

  test("byte-identical second write when lifecycle is supplied both times", () => {
    const res = writePreference(vault, basePref("idem-mod", { lifecycle: "verified" }));
    const first = readFileSync(res.path, "utf8");
    writePreference(vault, basePref("idem-mod", { lifecycle: "verified" }), { overwrite: true });
    const second = readFileSync(res.path, "utf8");
    expect(second).toBe(first);
  });
});
