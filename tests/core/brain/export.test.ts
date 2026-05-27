/**
 * Tests for `src/core/brain/export.ts` (§28).
 *
 * Two surfaces under test:
 *   - `exportPreferencesJson` — schema, row count, field set,
 *     deterministic ordering.
 *   - `exportPreferencesLlmsTxt` — llmstxt.org H1 + summary + per-
 *     status H2 sections, bullet shape, empty-section omission.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_EXPORT_SCHEMA_VERSION,
  exportPreferencesJson,
  exportPreferencesLlmsTxt,
} from "../../../src/core/brain/export.ts";
import {
  moveToRetired,
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
  vault = mkdtempSync(join(tmpdir(), "o2b-export-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: slug,
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-03T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.medium,
    confidence_value: 0.5,
    pinned: false,
    ...overrides,
  };
}

describe("exportPreferencesJson", () => {
  test("empty preferences/ → empty array, valid envelope", () => {
    const out = exportPreferencesJson(vault);
    expect(out.schema).toBe(BRAIN_EXPORT_SCHEMA_VERSION);
    expect(out.vault_basename.length).toBeGreaterThan(0);
    expect(out.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(out.preferences).toEqual([]);
  });

  test("mixed-status preferences are all included, retired/signal are excluded", () => {
    writePreference(vault, basePref("alpha", { status: BRAIN_PREFERENCE_STATUS.confirmed }));
    writePreference(
      vault,
      basePref("beta", {
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        confirmed_at: null,
      }),
    );
    writePreference(
      vault,
      basePref("gamma", {
        status: BRAIN_PREFERENCE_STATUS.quarantine,
        applied_count: 2,
        violated_count: 3,
      }),
    );
    // A retired pref + a stray signal must not leak into the export.
    writePreference(vault, basePref("dead"));
    moveToRetired(
      vault,
      join(vault, "Brain", "preferences", "pref-dead.md"),
      BRAIN_RETIRED_REASON.staleNoEvidence,
      { now: new Date("2026-05-10T00:00:00Z"), retired_by: "[[Brain/log/2026-05-10]]" },
    );
    writeFileSync(
      join(vault, "Brain", "inbox", "sig-2026-05-04-thing.md"),
      "---\nkind: brain-signal\n---\nbody\n",
    );

    const out = exportPreferencesJson(vault);
    expect(out.preferences.map((p) => p.id)).toEqual(["pref-alpha", "pref-beta", "pref-gamma"]);
  });

  test("row carries the canonical field set", () => {
    writePreference(vault, basePref("alpha", { scope: "writing", pinned: true }));
    const out = exportPreferencesJson(vault);
    const r = out.preferences[0]!;
    expect(r.id).toBe("pref-alpha");
    expect(r.topic).toBe("alpha");
    expect(r.scope).toBe("writing");
    expect(r.status).toBe("confirmed");
    expect(r.principle).toBe("Principle for alpha");
    expect(r.applied_count).toBe(1);
    expect(r.violated_count).toBe(0);
    expect(r.confidence).toBe(BRAIN_CONFIDENCE.medium);
    expect(r.confidence_value).toBe(0.5);
    expect(r.pinned).toBe(true);
    expect(r.last_evidence_at).toBe("2026-05-03T00:00:00Z");
    expect(r.created_at).toBe("2026-05-01T00:00:00Z");
    expect(r.confirmed_at).toBe("2026-05-02T00:00:00Z");
    // `writePreference` derives a default tag set; the export
    // surfaces whatever made it onto disk verbatim.
    expect(Array.isArray(r.tags)).toBe(true);
    expect(r.tags).toContain("brain/preference");
  });

  test("pref without scope → scope: null in the row", () => {
    writePreference(vault, basePref("no-scope"));
    const out = exportPreferencesJson(vault);
    expect(out.preferences[0]!.scope).toBeNull();
  });

  test("row.body carries the markdown sections after the frontmatter", () => {
    writePreference(vault, basePref("with-body"));
    const out = exportPreferencesJson(vault);
    const r = out.preferences[0]!;
    expect(typeof r.body).toBe("string");
    // `writePreference` emits the `## Origin` section listing the
    // evidenced_by wikilinks as part of the standard skeleton.
    // The row must surface that body verbatim so a downstream
    // consumer can re-emit the rule with its origin trail.
    expect(r.body).toContain("## Origin");
    expect(r.body).toContain("[[sig-2026-05-01-with-body]]");
  });

  test("output ordering is stable by id", () => {
    writePreference(vault, basePref("zeta"));
    writePreference(vault, basePref("alpha"));
    writePreference(vault, basePref("mu"));
    const out = exportPreferencesJson(vault);
    expect(out.preferences.map((p) => p.id)).toEqual(["pref-alpha", "pref-mu", "pref-zeta"]);
  });
});

describe("exportPreferencesLlmsTxt", () => {
  test("empty preferences → H1 + summary only, no H2 sections", () => {
    const txt = exportPreferencesLlmsTxt(vault);
    expect(txt).toContain("# ");
    expect(txt).toContain("Brain preferences");
    expect(txt).toContain("Auto-generated");
    expect(txt).not.toContain("## Confirmed");
    expect(txt).not.toContain("## Unconfirmed");
    expect(txt).not.toContain("## Quarantine");
  });

  test("mixed statuses render in fixed Confirmed → Unconfirmed → Quarantine order", () => {
    writePreference(vault, basePref("alpha", { status: BRAIN_PREFERENCE_STATUS.confirmed }));
    writePreference(
      vault,
      basePref("beta", {
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        confirmed_at: null,
      }),
    );
    writePreference(vault, basePref("gamma", { status: BRAIN_PREFERENCE_STATUS.quarantine }));
    const txt = exportPreferencesLlmsTxt(vault);
    const idxConfirmed = txt.indexOf("## Confirmed");
    const idxUnconfirmed = txt.indexOf("## Unconfirmed");
    const idxQuarantine = txt.indexOf("## Quarantine");
    expect(idxConfirmed).toBeGreaterThanOrEqual(0);
    expect(idxUnconfirmed).toBeGreaterThan(idxConfirmed);
    expect(idxQuarantine).toBeGreaterThan(idxUnconfirmed);
  });

  test("only-confirmed vault → only the Confirmed section", () => {
    writePreference(vault, basePref("solo"));
    const txt = exportPreferencesLlmsTxt(vault);
    expect(txt).toContain("## Confirmed");
    expect(txt).not.toContain("## Unconfirmed");
    expect(txt).not.toContain("## Quarantine");
  });

  test("bullet shape matches `- <id> (topic: X[, scope: Y]): <principle>`", () => {
    writePreference(vault, basePref("scoped", { scope: "writing" }));
    writePreference(vault, basePref("unscoped"));
    const txt = exportPreferencesLlmsTxt(vault);
    expect(txt).toContain("- pref-scoped (topic: scoped, scope: writing): Principle for scoped");
    expect(txt).toContain("- pref-unscoped (topic: unscoped): Principle for unscoped");
  });
});
