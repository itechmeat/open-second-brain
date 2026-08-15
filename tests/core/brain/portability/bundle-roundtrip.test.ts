/**
 * The defect: `exportBankBundle` composed four sections and
 * `importBankBundle` reconstructed one. Preferences travelled inside the
 * envelope and came back out as a count - `preferencesCarried` - so a
 * bundle taken as a backup could be imported into an empty vault and
 * report success while every rule it carried stayed on the floor. The
 * stated reason was that preferences have a confidence and audit
 * lifecycle a naive restore would overwrite; the fix is not to bypass
 * that lifecycle but to route the restore through the transaction that
 * owns it (`writePreferenceTxn`), so the trial window, the confidence
 * band, the revision counter and the audit trail are maintained.
 *
 * A second defect made the first one unfixable: the export projection
 * carried neither `unconfirmed_until` (required by every preference
 * write, with no other source) nor `revision` (the only ordering that
 * can tell a restore from a rewind). A backup that cannot express the
 * trial window cannot restore it.
 *
 * What this file deliberately does NOT cover:
 *   - the page-graph half of the import (`graph-import.test.ts` owns it);
 *   - page contracts and the sources dashboard, which remain reported as
 *     carried-not-restored and are asserted only at the section level;
 *   - concurrent importers racing for the same lockfile - the lock
 *     collision path is exercised by `preference-txn.test.ts`;
 *   - the CLI rendering of the result (`tests/cli/bank-bundle-cli.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BANK_BUNDLE_SCHEMA_VERSION,
  exportBankBundle,
  importBankBundle,
  type BankBundle,
  type BankImportResult,
} from "../../../../src/core/brain/portability/bundle.ts";
import {
  PREFERENCE_FIELDS_NOT_RESTORED,
  PREFERENCE_RESTORE_FAILURE,
} from "../../../../src/core/brain/portability/preference-restore.ts";
import type { ExportedPreferenceRow } from "../../../../src/core/brain/export.ts";
import {
  writePreference,
  type WritePreferenceInput,
} from "../../../../src/core/brain/preference.ts";
import { readPrefAudit } from "../../../../src/core/brain/pref-audit.ts";
import { brainDirs, preferencePath } from "../../../../src/core/brain/paths.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";

let src: string;
let dest: string;

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "o2b-bundle-rt-src-"));
  dest = mkdtempSync(join(tmpdir(), "o2b-bundle-rt-dest-"));
  for (const vault of [src, dest]) {
    mkdirSync(brainDirs(vault).preferences, { recursive: true });
    mkdirSync(brainDirs(vault).log, { recursive: true });
  }
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

/**
 * A preference whose every exported field carries a non-default value,
 * so a field that silently fails to restore cannot hide behind a
 * default that happens to match.
 */
function richPreference(overrides: Partial<WritePreferenceInput> = {}): WritePreferenceInput {
  return {
    slug: "alpha-rule",
    topic: "writing",
    principle: "state the rule in the imperative and name the artifact it governs",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: ["[[sig-2026-05-01-alpha]]", "[[sig-2026-05-02-alpha]]"],
    confirmed_at: "2026-05-02T00:00:00Z",
    scope: "writing",
    applied_count: 4,
    violated_count: 1,
    last_evidence_at: "2026-05-03T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.medium,
    confidence_value: 0.625,
    pinned: true,
    revision: 3,
    aliases: ["[[pref-alpha-old]]"],
    extraTags: ["brain/imported"],
    howToApply: "Apply it when the artifact is prose, not when it is code.",
    ...overrides,
  };
}

describe("bank bundle preference round-trip", () => {
  test("every exported preference field round-trips, or the result names it", () => {
    writePreference(src, richPreference());
    const bundle = exportBankBundle(src);
    const result = importBankBundle(dest, bundle, { mode: "skip" });

    const before = bundle.preferences[0]!;
    const after = exportBankBundle(dest).preferences.find((r) => r.id === before.id);
    expect(after).toBeDefined();

    // The field set is derived from what the exporter actually emitted,
    // never from a list written here: a field added to the projection
    // shows up in this loop the moment it ships.
    const fields = Object.keys(before) as ReadonlyArray<keyof ExportedPreferenceRow>;
    expect(fields.length).toBeGreaterThan(10);
    const drifted = fields.filter(
      (field) => JSON.stringify(before[field]) !== JSON.stringify(after![field]),
    );
    for (const field of drifted) {
      expect(result.preferences.fieldsNotRestored).toContain(field);
    }
    // No stale names: a field named as not-restored must still exist.
    for (const named of result.preferences.fieldsNotRestored) {
      expect(fields).toContain(named);
    }
    // Non-vacuous: the rendered body is the one field a write cannot
    // reconstruct, and this fixture carries prose that proves it.
    expect(drifted).toContain("body");
    expect(PREFERENCE_FIELDS_NOT_RESTORED).toContain("body");
  });

  test("every bundle section is accounted for in the import result", () => {
    writePreference(src, richPreference());
    const bundle = exportBankBundle(src);
    const result = importBankBundle(dest, bundle, { mode: "skip" });

    // Declared once, keyed by section: a new section on BankBundle has
    // to be added here, which is the moment someone decides whether it
    // restores or is reported as carried.
    const REPORTED_AS: Readonly<Record<string, keyof BankImportResult | null>> = Object.freeze({
      schema: "schema",
      generated_at: null,
      vault_basename: null,
      graph: "graph",
      preferences: "preferences",
      pages: "pagesCarried",
      sources: "sourcesCarried",
    });
    for (const section of Object.keys(bundle) as ReadonlyArray<keyof BankBundle>) {
      expect(Object.keys(REPORTED_AS)).toContain(section);
      const reported = REPORTED_AS[section];
      if (reported !== null) expect(result[reported!]).toBeDefined();
    }
    expect(result.pagesCarried).toBe(bundle.pages.length);
    expect(result.sourcesCarried).toBe(true);
  });

  test("the trial window and confidence band survive the restore", () => {
    writePreference(
      src,
      richPreference({
        slug: "trial-rule",
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        confirmed_at: null,
        unconfirmed_until: "2026-09-30T00:00:00Z",
        confidence: BRAIN_CONFIDENCE.low,
        confidence_value: 0.125,
      }),
    );
    const result = importBankBundle(dest, exportBankBundle(src), { mode: "skip" });
    expect(result.preferences.failed).toEqual([]);

    const restored = exportBankBundle(dest).preferences.find((r) => r.id === "pref-trial-rule")!;
    expect(restored.unconfirmed_until).toBe("2026-09-30T00:00:00Z");
    expect(restored.status).toBe(BRAIN_PREFERENCE_STATUS.unconfirmed);
    expect(restored.confirmed_at).toBeNull();
    expect(restored.confidence).toBe(BRAIN_CONFIDENCE.low);
    expect(restored.confidence_value).toBe(0.125);
  });

  test("the restore is recorded in the audit trail as a restore", () => {
    writePreference(src, richPreference());
    const result = importBankBundle(dest, exportBankBundle(src), { mode: "skip" });
    expect(result.preferences.restored).toContain("pref-alpha-rule");

    const audit = readPrefAudit(dest, "pref-alpha-rule");
    expect(audit.warnings).toEqual([]);
    expect(audit.records.length).toBe(1);
    const record = audit.records[0]!;
    expect(record.reason).toBe("bundle_restore");
    expect(record.revision_after).toBe(3);
  });

  test("a bundle that is behind the target vault is refused, not applied", () => {
    writePreference(src, richPreference({ revision: 3 }));
    const bundle = exportBankBundle(src);
    // The target already carries a newer edit of the same rule.
    writePreference(
      dest,
      richPreference({
        revision: 7,
        principle: "the newer principle the target vault already holds",
      }),
      { overwrite: true },
    );

    const result = importBankBundle(dest, bundle, { mode: "skip" });
    expect(result.preferences.restored).toEqual([]);
    expect(result.preferences.failed.length).toBe(1);
    expect(result.preferences.failed[0]!.id).toBe("pref-alpha-rule");
    expect(result.preferences.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.revisionConflict);
    // The on-disk record is untouched.
    const kept = readFileSync(preferencePath(dest, "alpha-rule"), "utf8");
    expect(kept).toContain("the newer principle the target vault already holds");
  });

  test("a divergent record at the same revision is refused, not silently overwritten", () => {
    writePreference(src, richPreference({ revision: 5 }));
    const bundle = exportBankBundle(src);
    writePreference(
      dest,
      richPreference({ revision: 5, principle: "a different rule that shares a revision number" }),
      { overwrite: true },
    );

    const result = importBankBundle(dest, bundle, { mode: "skip" });
    expect(result.preferences.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.revisionConflict);
    expect(readFileSync(preferencePath(dest, "alpha-rule"), "utf8")).toContain(
      "a different rule that shares a revision number",
    );
  });

  test("a bundle ahead of the target vault moves the preference forward", () => {
    writePreference(
      src,
      richPreference({ revision: 9, principle: "the newer rule from the bank" }),
    );
    const bundle = exportBankBundle(src);
    writePreference(dest, richPreference({ revision: 2 }), { overwrite: true });

    const result = importBankBundle(dest, bundle, { mode: "skip" });
    expect(result.preferences.failed).toEqual([]);
    expect(result.preferences.restored).toContain("pref-alpha-rule");
    const restored = exportBankBundle(dest).preferences[0]!;
    expect(restored.revision).toBe(9);
    expect(restored.principle).toBe("the newer rule from the bank");
  });

  test("the outcome follows the revision, not the order rows appear in", () => {
    writePreference(src, richPreference({ revision: 4, principle: "the older rule of the pair" }));
    const older = exportBankBundle(src).preferences[0]!;
    writePreference(src, richPreference({ revision: 6, principle: "the newer rule of the pair" }), {
      overwrite: true,
    });
    const newer = exportBankBundle(src).preferences[0]!;

    const outcome = (rows: ReadonlyArray<ExportedPreferenceRow>): string => {
      const target = mkdtempSync(join(tmpdir(), "o2b-bundle-rt-order-"));
      try {
        mkdirSync(brainDirs(target).preferences, { recursive: true });
        importBankBundle(target, {
          schema: BANK_BUNDLE_SCHEMA_VERSION,
          graph: { nodes: [] },
          preferences: rows,
        });
        return exportBankBundle(target).preferences[0]!.principle;
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    };

    expect(outcome([older, newer])).toBe("the newer rule of the pair");
    expect(outcome([newer, older])).toBe("the newer rule of the pair");
  });

  test("a version-1 bundle written before the restore existed still imports", () => {
    writePreference(src, richPreference());
    writeFileSync(join(src, "Notes.md"), "---\ntitle: Notes\n---\nbody\n");
    const bundle = exportBankBundle(src);
    // The shape a pre-restore export produced: no trial window, no revision.
    const legacyRows = bundle.preferences.map((row) => {
      const { unconfirmed_until: _window, revision: _revision, ...rest } = row;
      return rest;
    });
    const legacy = { ...bundle, preferences: legacyRows };

    const result = importBankBundle(dest, legacy, { mode: "skip" });
    expect(result.schema).toBe(BANK_BUNDLE_SCHEMA_VERSION);
    expect(result.graph.created).toContain("Notes.md");
    // The rule is confirmed, so its trial window is inert and derivable
    // from the row's own `confirmed_at`. Refusing it would have discarded
    // recoverable data over a moot field - and a bank bundle IS the backup,
    // so there is no re-export to supply what the projection never carried.
    // The derivation is reported rather than passed off as carried data;
    // `tests/core/brain/portability/legacy-bundle-restore.test.ts` owns the
    // full rule, including the `unconfirmed` row that is still refused.
    expect(result.preferences.restored).toEqual(["pref-alpha-rule"]);
    expect(result.preferences.failed).toEqual([]);
    expect(result.preferences.derived.length).toBe(1);
    expect(result.preferences.derived[0]!.field).toBe("unconfirmed_until");
    expect(existsSync(preferencePath(dest, "alpha-rule"))).toBe(true);
    // `revision` is absent-as-zero, which is behind every later write and
    // ahead of nothing - so a legacy row never rewinds the destination.
    expect(readFileSync(preferencePath(dest, "alpha-rule"), "utf8")).toContain(
      "unconfirmed_until:",
    );
  });

  test("a malformed row fails per-entry and never counts as carried-and-restored", () => {
    writePreference(src, richPreference());
    const bundle = exportBankBundle(src);
    const mixed = {
      ...bundle,
      preferences: [{ id: 42 }, ...bundle.preferences, { id: "pref-x", topic: "t" }],
    };
    const result = importBankBundle(dest, mixed, { mode: "skip" });
    expect(result.preferences.carried).toBe(3);
    expect(result.preferences.restored.length).toBe(1);
    expect(result.preferences.failed.length).toBe(2);
    expect(result.preferences.restored.length + result.preferences.failed.length).toBe(
      result.preferences.carried,
    );
    for (const failure of result.preferences.failed) {
      expect(failure.reason).toBe(PREFERENCE_RESTORE_FAILURE.malformedRow);
    }
  });

  test("a preferences section that is not an array is refused, not read as empty", () => {
    const result = importBankBundle(dest, {
      schema: BANK_BUNDLE_SCHEMA_VERSION,
      graph: { nodes: [] },
      preferences: "not-an-array",
    });
    expect(result.preferences.carried).toBe(1);
    expect(result.preferences.restored).toEqual([]);
    expect(result.preferences.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.malformedRow);
  });

  test("a bundle with no preferences section reports an empty restore, not a failure", () => {
    const result = importBankBundle(dest, {
      schema: BANK_BUNDLE_SCHEMA_VERSION,
      graph: { nodes: [] },
    });
    expect(result.preferences.carried).toBe(0);
    expect(result.preferences.restored).toEqual([]);
    expect(result.preferences.failed).toEqual([]);
    expect(result.preferences.fieldsNotRestored.length).toBeGreaterThan(0);
  });
});
