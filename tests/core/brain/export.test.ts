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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_EXPORT_SCHEMA_VERSION,
  collectExportRows,
  collectPreferenceRows,
  exportPreferencesJson,
  exportPreferencesLlmsTxt,
  exportPreferencesLlmsTxtDetailed,
  PreferenceParseError,
  type PreferenceDenyKey,
} from "../../../src/core/brain/export.ts";
import {
  PRIVACY_DENY_MARKER_VALUES,
  PRIVACY_MARKER_KEYS,
} from "../../../src/core/graph/privacy-markers.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";
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

describe("collector privacy denial reporting", () => {
  /**
   * Stamp one extra frontmatter line onto a written preference file.
   * The informal markers (`access:` and siblings) have no write-input
   * field - they are hand-added user-tier lines - so the test adds one
   * the same way an operator does.
   */
  function stampMarker(slug: string, line: string): void {
    const abs = join(vault, "Brain", "preferences", `pref-${slug}.md`);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${line}\n`));
  }

  test("every informal marker key times deny value denies, and rows stay complete", () => {
    // One unmarked control row plus one file per marker key x deny value.
    // Denial is a report BESIDE the rows: the collector's `rows` stay
    // complete because the import-side topic maps must keep seeing every
    // rule, marker or not.
    writePreference(vault, basePref("open"));
    const marked: string[] = [];
    for (const key of PRIVACY_MARKER_KEYS) {
      for (const value of PRIVACY_DENY_MARKER_VALUES) {
        const slug = `marked-${key}-${value}`;
        writePreference(vault, basePref(slug));
        stampMarker(slug, `${key}: ${value}`);
        marked.push(`pref-${slug}`);
      }
    }

    const out = collectPreferenceRows(vault);
    expect(out.rows).toHaveLength(1 + marked.length);
    expect(out.rows.map((r) => r.id)).toContain("pref-open");
    // Sorted by id, like the rows: the denial list rides byte-deterministic
    // surfaces (the json envelope's omitted, the bundle's preferences_omitted).
    expect(out.denied.map((d) => d.id)).toEqual(marked.toSorted());
    // The reason stays the "visibility" class for machine readers; the key
    // names the frontmatter key whose value actually denied the row.
    const expectedKeys = new Map<string, PreferenceDenyKey>(
      marked.map((id) => [id, id.replace("pref-marked-", "").split("-")[0] as PreferenceDenyKey]),
    );
    for (const d of out.denied) {
      expect(d.reason).toBe("visibility");
      // Every denied id is asserted above to come from `marked`, so the
      // expected key is always present.
      expect(d.denied_by).toBe(expectedKeys.get(d.id)!);
    }
  });

  test("visibility: private denies the row", () => {
    writePreference(vault, basePref("reserved", { visibility: [REMOTE_DENY_VISIBILITY_TOKEN] }));
    writePreference(vault, basePref("open"));

    const out = collectPreferenceRows(vault);
    expect(out.denied).toEqual([
      { id: "pref-reserved", reason: "visibility", denied_by: "visibility" },
    ]);
    // Denied rows ride beside the kept ones, never inside them.
    expect(out.rows.map((r) => r.id).toSorted()).toEqual(["pref-open", "pref-reserved"]);
  });

  test("a vault without reservations denies nothing", () => {
    writePreference(vault, basePref("plain"));

    const out = collectPreferenceRows(vault);
    expect(out.denied).toEqual([]);
    expect(out.rows).toHaveLength(1);
  });

  test("parse refusals behave exactly as before denial reporting", () => {
    writePreference(vault, basePref("good"));
    writeFileSync(join(vault, "Brain", "preferences", "pref-broken.md"), "no frontmatter here\n");

    const scan = collectPreferenceRows(vault);
    expect(scan.failures.map((f) => f.path)).toEqual(["Brain/preferences/pref-broken.md"]);
    expect(scan.denied).toEqual([]);
    expect(() => collectExportRows(vault)).toThrow(PreferenceParseError);
  });
});

describe("shared-lane omission reporting", () => {
  function stampMarker(slug: string, line: string): void {
    const abs = join(vault, "Brain", "preferences", `pref-${slug}.md`);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${line}\n`));
  }

  test("a reserved preference leaves the json envelope and is named in omitted", () => {
    writePreference(vault, basePref("open"));
    writePreference(vault, basePref("reserved"));
    stampMarker("reserved", "access: private");

    const out = exportPreferencesJson(vault);
    expect(out.preferences.map((p) => p.id)).toEqual(["pref-open"]);
    expect(out.omitted).toEqual([
      { id: "pref-reserved", reason: "visibility", denied_by: "access" },
    ]);
    // The envelope's version is additive, not a bump: a consumer written
    // against the field-less envelope keeps working.
    expect(out.schema).toBe(BRAIN_EXPORT_SCHEMA_VERSION);
  });

  test("omitted is absent when nothing is denied", () => {
    writePreference(vault, basePref("plain"));

    const out = exportPreferencesJson(vault);
    expect("omitted" in out).toBe(false);
  });

  test("the llms-txt detailed variant leaves the reserved row out of the text and names it", () => {
    writePreference(vault, basePref("open", { scope: "writing" }));
    writePreference(vault, basePref("reserved"));
    stampMarker("reserved", "confidentiality: secret");

    const detail = exportPreferencesLlmsTxtDetailed(vault);
    expect(detail.text).toContain("- pref-open (topic: open, scope: writing): Principle for open");
    expect(detail.text).not.toContain("pref-reserved");
    expect(detail.text).not.toContain("Principle for reserved");
    expect(detail.omitted).toEqual([
      { id: "pref-reserved", reason: "visibility", denied_by: "confidentiality" },
    ]);
    // The stable string signature delegates to the detailed one, so the
    // two never disagree about what the document contains.
    expect(exportPreferencesLlmsTxt(vault)).toBe(detail.text);
  });
});
