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
import {
  renderDerivedStoreCoverage,
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
