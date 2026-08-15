/**
 * The defect: every bank bundle taken before the trial window entered the
 * export projection failed to restore, and the verb exited 1.
 *
 * A pre-change export row carries no `unconfirmed_until`, so the restore
 * refused it outright with `missing_trial_window`. The reasoning - never
 * invent a promotion deadline - is right, and the conclusion was too broad:
 * a bank bundle IS the backup, so when the source vault is gone there is no
 * re-export, no `--force`, and no way to supply the field. The unit's own
 * stated purpose ("a bundle taken as a backup could be imported into an
 * empty vault and report success while every rule it carried stayed on the
 * floor") stayed exactly true for every legacy bundle, only reporting exit 1
 * instead of exit 0.
 *
 * The refusal was also over-strict where it cost most. The trial window is
 * read by exactly one consumer (`planAutoRetires`) and only while a
 * preference is `unconfirmed`; for a confirmed or quarantined rule it is
 * inert. Refusing to restore a confirmed rule over a moot field discards
 * recoverable data.
 *
 * So: derive the window where the row's OWN fields determine it (a closed
 * window at `confirmed_at`, else `created_at` - the convention the
 * force-confirmed writer already uses), report every row restored on a
 * derived value, and keep refusing the one case where the deadline is live
 * and unreconstructable - an `unconfirmed` row. Nothing here fabricates a
 * future deadline.
 *
 * The second defect pinned here (cross-cutting review): the restore writes
 * `topic` verbatim while the dream pass indexes topics through a fold, so a
 * bundle spelling a topic `Api-Key` next to a local `api-key` created a
 * permanent contention - consolidation for that key silently disabled, the
 * inbox accumulating - and neither path knew the other existed. The restore
 * still writes the topic the bundle declared (rewriting it would be a
 * different lie) and now REPORTS the collision it just created.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectExportRows,
  type ExportedPreferenceRow,
} from "../../../../src/core/brain/export.ts";
import { brainDirs, preferencePath } from "../../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../../src/core/brain/preference.ts";
import {
  PREFERENCE_RESTORE_FAILURE,
  restorePreferences,
  TRIAL_WINDOW_DERIVED_FROM,
} from "../../../../src/core/brain/portability/preference-restore.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";

let src: string;
let dest: string;

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "o2b-legacy-src-"));
  dest = mkdtempSync(join(tmpdir(), "o2b-legacy-dest-"));
  for (const vault of [src, dest]) {
    mkdirSync(brainDirs(vault).preferences, { recursive: true });
    mkdirSync(brainDirs(vault).log, { recursive: true });
  }
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

/** Strip the two fields a pre-change export projection never emitted. */
function legacyRow(row: ExportedPreferenceRow): Record<string, unknown> {
  const { unconfirmed_until: _window, revision: _revision, ...rest } = row;
  return rest;
}

function seedConfirmed(slug: string, topic = "writing"): void {
  writePreference(src, {
    slug,
    topic,
    principle: `state the ${slug} rule and name the artifact it governs`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: ["[[sig-2026-05-01-alpha]]"],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 4,
    violated_count: 1,
  });
}

describe("a legacy bundle restores what can be honestly restored", () => {
  test("a confirmed row with no trial window restores on a derived one", () => {
    seedConfirmed("alpha-rule");
    const rows = collectExportRows(src).map(legacyRow);

    const result = restorePreferences(dest, rows, { agent: "bank-import" });

    expect(result.restored).toEqual(["pref-alpha-rule"]);
    expect(result.failed).toEqual([]);
    expect(result.restored.length + result.failed.length).toBe(result.carried);
    expect(existsSync(preferencePath(dest, "alpha-rule"))).toBe(true);

    // The window is CLOSED at the instant the row itself records for the
    // promotion - not a deadline in the future, and not a re-dating of the
    // promotion, which is the class of defect this release removes.
    const written = parsePreference(preferencePath(dest, "alpha-rule"));
    expect(written.unconfirmed_until).toBe("2026-05-02T00:00:00Z");
    expect(written.confirmed_at).toBe("2026-05-02T00:00:00Z");
    expect(written.status).toBe(BRAIN_PREFERENCE_STATUS.confirmed);
  });

  test("the result says which rows were restored on a derived value", () => {
    seedConfirmed("alpha-rule");
    const rows = collectExportRows(src).map(legacyRow);

    const result = restorePreferences(dest, rows);

    expect(result.derived.length).toBe(1);
    expect(result.derived[0]!.id).toBe("pref-alpha-rule");
    expect(result.derived[0]!.index).toBe(0);
    expect(result.derived[0]!.field).toBe("unconfirmed_until");
    expect(result.derived[0]!.derivedFrom).toBe(TRIAL_WINDOW_DERIVED_FROM.confirmedAt);
    expect(result.derived[0]!.value).toBe("2026-05-02T00:00:00Z");
  });

  test("a row that CARRIES the window derives nothing - the report is discriminating", () => {
    seedConfirmed("alpha-rule");
    const rows = collectExportRows(src);

    const result = restorePreferences(dest, rows);

    expect(result.restored).toEqual(["pref-alpha-rule"]);
    expect(result.derived).toEqual([]);
    expect(parsePreference(preferencePath(dest, "alpha-rule")).unconfirmed_until).toBe(
      "2026-05-08T00:00:00Z",
    );
  });

  test("a confirmed row with no confirmed_at falls back to created_at", () => {
    seedConfirmed("alpha-rule");
    const rows = collectExportRows(src).map((row) => {
      const legacy = legacyRow(row);
      legacy["confirmed_at"] = null;
      return legacy;
    });

    const result = restorePreferences(dest, rows);

    expect(result.restored).toEqual(["pref-alpha-rule"]);
    expect(result.derived[0]!.derivedFrom).toBe(TRIAL_WINDOW_DERIVED_FROM.createdAt);
    expect(parsePreference(preferencePath(dest, "alpha-rule")).unconfirmed_until).toBe(
      "2026-05-01T00:00:00Z",
    );
  });

  test("a quarantined row restores too - the window is inert for it as well", () => {
    seedConfirmed("alpha-rule");
    const rows = collectExportRows(src).map((row) => {
      const legacy = legacyRow(row);
      legacy["status"] = BRAIN_PREFERENCE_STATUS.quarantine;
      return legacy;
    });

    const result = restorePreferences(dest, rows);

    expect(result.restored).toEqual(["pref-alpha-rule"]);
    expect(result.failed).toEqual([]);
  });
});

describe("what genuinely cannot be reconstructed is still refused", () => {
  test("an unconfirmed row with no trial window is refused, not invented", () => {
    writePreference(src, {
      slug: "trial-rule",
      topic: "writing",
      principle: "the rule still under trial",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.unconfirmed,
      evidenced_by: ["[[sig-2026-05-01-alpha]]"],
    });
    const rows = collectExportRows(src).map(legacyRow);

    const result = restorePreferences(dest, rows);

    expect(result.restored).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.missingTrialWindow);
    expect(result.derived).toEqual([]);
    // No file, and above all no fabricated deadline on disk.
    expect(existsSync(preferencePath(dest, "trial-rule"))).toBe(false);
  });

  test("a structurally malformed row still fails as malformed, not as a missing window", () => {
    const result = restorePreferences(dest, [{ id: "pref-x", topic: "t" }]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.malformedRow);
  });
});

describe("a restored topic that folds onto a topic the vault already has", () => {
  test("the row restores verbatim and the collision it creates is reported", () => {
    // The destination already owns the folded key under a different
    // spelling; the bundle's row keeps the spelling the bundle declared.
    writePreference(dest, {
      slug: "local-rule",
      topic: "api-key",
      principle: "the rule the destination vault already had",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-01-local]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
    });
    seedConfirmed("imported-rule", "Api-Key");
    const rows = collectExportRows(src);

    const result = restorePreferences(dest, rows);

    expect(result.restored).toEqual(["pref-imported-rule"]);
    expect(result.failed).toEqual([]);
    // Verbatim: the bundle said `Api-Key` and the vault records `Api-Key`.
    expect(parsePreference(preferencePath(dest, "imported-rule")).topic).toBe("Api-Key");
    // And the contention the write just created is named, not left for the
    // dream pass to discover as a silent stall.
    expect(result.topicKeyCollisions.length).toBe(1);
    const collision = result.topicKeyCollisions[0]!;
    expect(collision.key).toBe("api-key");
    expect([...collision.topics].toSorted()).toEqual(["Api-Key", "api-key"]);
    expect([...collision.prefIds].toSorted()).toEqual(["pref-imported-rule", "pref-local-rule"]);
  });

  test("two rows of the SAME bundle colliding with each other are reported once", () => {
    seedConfirmed("one-rule", "api-key");
    seedConfirmed("two-rule", "API-KEY");
    const rows = collectExportRows(src);

    const result = restorePreferences(dest, rows);

    expect(result.restored.length).toBe(2);
    expect(result.topicKeyCollisions.length).toBe(1);
    expect([...result.topicKeyCollisions[0]!.topics].toSorted()).toEqual(["API-KEY", "api-key"]);
  });

  test("an identical topic spelling is not a collision - it is the ordinary case", () => {
    writePreference(dest, {
      slug: "local-rule",
      topic: "writing",
      principle: "the rule the destination vault already had",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-01-local]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
    });
    seedConfirmed("imported-rule", "writing");

    const result = restorePreferences(dest, collectExportRows(src));

    expect(result.restored).toEqual(["pref-imported-rule"]);
    expect(result.topicKeyCollisions).toEqual([]);
  });

  test("a row that did not restore cannot contribute a collision", () => {
    writePreference(dest, {
      slug: "local-rule",
      topic: "api-key",
      principle: "the rule the destination vault already had",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-01-local]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
    });
    writePreference(src, {
      slug: "trial-rule",
      topic: "Api-Key",
      principle: "the rule still under trial",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.unconfirmed,
      evidenced_by: ["[[sig-2026-05-01-alpha]]"],
    });
    const rows = collectExportRows(src).map(legacyRow);

    const result = restorePreferences(dest, rows);

    expect(result.restored).toEqual([]);
    expect(result.topicKeyCollisions).toEqual([]);
  });
});
