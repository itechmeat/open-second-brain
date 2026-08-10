/**
 * One vocabulary for two surfaces.
 *
 * `o2b brain snapshot log` and `o2b brain rollback --list` each shipped
 * their own copy of "does this snapshot cover the derived store", and the
 * copies had already begun to disagree - one drew the no-record case from
 * a named constant, the other from a bare literal. These assertions are
 * what keeps them one answer.
 */

import { describe, expect, test } from "bun:test";

import type { BrainManifestDerivedStore } from "../../src/core/brain/manifest.ts";
import type { RestoreDerivedStoreResult } from "../../src/core/brain/snapshot.ts";
import {
  renderDerivedStoreCoverage,
  renderDerivedStoreRestore,
  renderSnapshotReason,
  SNAPSHOT_UNKNOWN_LABEL,
} from "../../src/cli/brain/snapshot-render.ts";

function record(over: Partial<BrainManifestDerivedStore>): BrainManifestDerivedStore {
  return {
    included: false,
    source_path: "/tmp/vault/.open-second-brain/brain.sqlite",
    archive_name: null,
    archive_sha256: null,
    archive_size: null,
    live_size: 10,
    exclusion_reason: null,
    ...over,
  } as BrainManifestDerivedStore;
}

describe("renderDerivedStoreCoverage", () => {
  test("a snapshot with no record is unknown, never excluded", () => {
    // Nothing checked, so nothing may be claimed. Rendering this as
    // `excluded` would state a decision nobody made.
    const rendered = renderDerivedStoreCoverage(null);
    expect(rendered).toBe(SNAPSHOT_UNKNOWN_LABEL);
    expect(rendered).not.toContain("excluded");
  });

  test("the no-record answer is identical with and without the size option", () => {
    expect(renderDerivedStoreCoverage(null)).toBe(
      renderDerivedStoreCoverage(null, { withArchiveSize: true }),
    );
  });

  test("an excluded record names its reason on both surfaces", () => {
    const excluded = record({ exclusion_reason: "not-requested" });
    expect(renderDerivedStoreCoverage(excluded)).toBe("excluded (not-requested)");
    expect(renderDerivedStoreCoverage(excluded, { withArchiveSize: true })).toBe(
      "excluded (not-requested)",
    );
  });

  test("an excluded record with no reason says so rather than reading as clean", () => {
    expect(renderDerivedStoreCoverage(record({}))).toContain("unspecified");
  });

  test("the size is the only difference between the two surfaces", () => {
    const included = record({
      included: true,
      archive_name: "run.store.sqlite.zst",
      archive_size: 4096,
    });
    expect(renderDerivedStoreCoverage(included)).toBe("included");
    expect(renderDerivedStoreCoverage(included, { withArchiveSize: true })).toBe(
      "included (4096 bytes)",
    );
  });
});

/** A restore outcome with the no-record defaults, overridden per case. */
function outcome(over: Partial<RestoreDerivedStoreResult>): RestoreDerivedStoreResult {
  return {
    replaced: false,
    coverage_known: false,
    path: null,
    exclusion_reason: null,
    store_archive_present: false,
    ...over,
  };
}

describe("renderDerivedStoreRestore", () => {
  test("a replaced store names where it was written", () => {
    const rendered = renderDerivedStoreRestore(
      outcome({
        replaced: true,
        coverage_known: true,
        path: "/vault/.open-second-brain/brain.sqlite",
        store_archive_present: true,
      }),
    );
    expect(rendered).toContain("replaced");
    expect(rendered).toContain("/vault/.open-second-brain/brain.sqlite");
  });

  test("a recorded exclusion names the reason it recorded", () => {
    const rendered = renderDerivedStoreRestore(
      outcome({ coverage_known: true, exclusion_reason: "not-requested" }),
    );
    expect(rendered).toContain("not-requested");
    expect(rendered).toContain("live store left untouched");
  });

  test("no record and no archive does not claim the feature is younger than the snapshot", () => {
    // Nothing was archived either way, so the honest answer is that no
    // record exists - not that the archive is older than the feature,
    // which this surface cannot know.
    const rendered = renderDerivedStoreRestore(outcome({}));
    expect(rendered).toContain(SNAPSHOT_UNKNOWN_LABEL);
    expect(rendered).toContain("no store archive");
    expect(rendered).toContain("live store left untouched");
  });

  test("no record WITH an archive on disk says the record is missing", () => {
    // The rollback surface used to render this as "snapshot predates
    // derived-store coverage" while the store archive sat next to the tar.
    const rendered = renderDerivedStoreRestore(outcome({ store_archive_present: true }));
    expect(rendered).toContain("record");
    expect(rendered).not.toContain("predates");
    expect(rendered).toContain("live store left untouched");
  });

  test("the two no-record answers are different sentences", () => {
    expect(renderDerivedStoreRestore(outcome({}))).not.toBe(
      renderDerivedStoreRestore(outcome({ store_archive_present: true })),
    );
  });
});

describe("renderSnapshotReason", () => {
  test("an unrecorded reason uses the same word as an unrecorded coverage record", () => {
    // Two different unknowns spelled two different ways is how an
    // operator learns to distrust both columns.
    expect(renderSnapshotReason(null)).toBe(SNAPSHOT_UNKNOWN_LABEL);
  });

  test("a recorded reason is passed through verbatim", () => {
    expect(renderSnapshotReason("dream")).toBe("dream");
  });
});
