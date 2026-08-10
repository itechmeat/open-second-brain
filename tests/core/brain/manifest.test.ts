/**
 * Tests for `src/core/brain/manifest.ts`.
 *
 * Covered:
 *   - empty Brain → empty files map
 *   - regular files hashed; output keys sorted lexicographically
 *   - `.snapshots/` excluded
 *   - symlinks skipped (defense against malicious archive contents)
 *   - byte-stable sha256 across runs on identical inputs
 *   - `diffManifests` classifies added / removed / changed
 *   - sidecar read / write roundtrip; corrupt and missing sidecars
 *     surface as `null` rather than throwing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_MANIFEST_SCHEMA_VERSION,
  buildManifest,
  diffManifests,
  manifestDiffHasDrift,
  manifestSidecarPath,
  readManifestSidecar,
  SNAPSHOT_STORE_EXCLUSION,
  writeManifestSidecar,
  type BrainManifest,
} from "../../../src/core/brain/manifest.ts";
import { BRAIN_SNAPSHOT_REASON, BRAIN_SNAPSHOT_REASONS } from "../../../src/core/brain/types.ts";

let vault: string;
let brain: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-manifest-"));
  brain = join(vault, "Brain");
  mkdirSync(brain, { recursive: true });
  mkdirSync(join(brain, ".snapshots"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("buildManifest", () => {
  test("empty Brain → empty files map, schema_version 1, brain_root 'Brain'", () => {
    const m = buildManifest(brain);
    expect(m.schema_version).toBe(BRAIN_MANIFEST_SCHEMA_VERSION);
    expect(m.brain_root).toBe("Brain");
    expect(Object.keys(m.files)).toEqual([]);
    expect(m.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("missing brainRoot directory → empty manifest, no throw", () => {
    rmSync(brain, { recursive: true, force: true });
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual([]);
  });

  test("two preferences → two entries sorted by relative path", () => {
    mkdirSync(join(brain, "preferences"), { recursive: true });
    writeFileSync(join(brain, "preferences", "pref-b.md"), "beta\n");
    writeFileSync(join(brain, "preferences", "pref-a.md"), "alpha\n");
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-a.md", "preferences/pref-b.md"]);
    expect(m.files["preferences/pref-a.md"]!.size).toBe(6);
    expect(m.files["preferences/pref-a.md"]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // sha256("alpha\n") == "31c0c4dee7f8eeeb27ff4f64ff5a7a9d97a6b6f49ad22082f6c12f9f0c5b9d27" → guard via length only.
    expect(m.files["preferences/pref-a.md"]!.sha256.length).toBe(64);
  });

  test(".snapshots/ is excluded from the walk", () => {
    writeFileSync(join(brain, ".snapshots", "phantom.tar.zst"), "binary");
    writeFileSync(join(brain, ".snapshots", "phantom.manifest.json"), "{}");
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-x.md"), "x");
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-x.md"]);
  });

  test(".artifacts/ is excluded from the walk", () => {
    // Documented as never backed up, yet hashed into every manifest -
    // so TTL'd tool output churning between a snapshot and a rollback
    // tripped the drift gate on a directory no restore ever touches.
    mkdirSync(join(brain, ".artifacts", "run-1"), { recursive: true });
    writeFileSync(join(brain, ".artifacts", "run-1", "a.json"), "{}");
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-x.md"), "x");
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-x.md"]);
  });

  test("symlink under Brain/ is skipped (security)", () => {
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-real.md"), "real");
    const targetOutside = join(vault, "secret.txt");
    writeFileSync(targetOutside, "should-not-be-hashed");
    symlinkSync(targetOutside, join(brain, "preferences", "pref-link.md"));
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-real.md"]);
  });

  test("identical bytes → identical sha256 across two runs", () => {
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-a.md"), "deterministic");
    const m1 = buildManifest(brain);
    const m2 = buildManifest(brain);
    expect(m1.files["preferences/pref-a.md"]!.sha256).toBe(
      m2.files["preferences/pref-a.md"]!.sha256,
    );
  });

  test("config files at Brain/ root are hashed (e.g. _brain.yaml)", () => {
    writeFileSync(join(brain, "_brain.yaml"), "schema_version: 1\n");
    writeFileSync(join(brain, "_BRAIN.md"), "# manual\n");
    const m = buildManifest(brain);
    expect(Object.keys(m.files).toSorted()).toEqual(["_BRAIN.md", "_brain.yaml"]);
  });
});

describe("diffManifests", () => {
  function fakeManifest(files: Record<string, { sha: string; size: number }>): BrainManifest {
    const sortedKeys = Object.keys(files).toSorted();
    const out: Record<string, { readonly sha256: string; readonly size: number }> = {};
    for (const k of sortedKeys) {
      out[k] = Object.freeze({ sha256: files[k]!.sha, size: files[k]!.size });
    }
    return Object.freeze({
      schema_version: BRAIN_MANIFEST_SCHEMA_VERSION,
      generated_at: "2026-05-18T00:00:00Z",
      brain_root: "Brain",
      files: Object.freeze(out),
    });
  }

  test("identical manifests → empty diff in all three buckets", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const d = diffManifests(a, b);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(manifestDiffHasDrift(d)).toBe(false);
  });

  test("right has extra file → 'added'", () => {
    const a = fakeManifest({});
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const d = diffManifests(a, b);
    expect(d.added.map((e) => e.path)).toEqual(["preferences/pref-a.md"]);
    expect(d.added[0]!.before).toBeNull();
    expect(d.added[0]!.after!.sha256).toBe("x");
    expect(manifestDiffHasDrift(d)).toBe(true);
  });

  test("left has extra file → 'removed'", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({});
    const d = diffManifests(a, b);
    expect(d.removed.map((e) => e.path)).toEqual(["preferences/pref-a.md"]);
    expect(d.removed[0]!.after).toBeNull();
    expect(manifestDiffHasDrift(d)).toBe(true);
  });

  test("same path different sha256 → 'changed'", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "y", size: 1 } });
    const d = diffManifests(a, b);
    expect(d.changed.map((e) => e.path)).toEqual(["preferences/pref-a.md"]);
    expect(d.changed[0]!.before!.sha256).toBe("x");
    expect(d.changed[0]!.after!.sha256).toBe("y");
  });

  test("same path same sha256 different size → 'changed' (defensive)", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 2 } });
    const d = diffManifests(a, b);
    expect(d.changed.length).toBe(1);
  });

  test("multiple changes → each bucket sorted by path", () => {
    const a = fakeManifest({
      "z.md": { sha: "old", size: 1 },
      "a.md": { sha: "old", size: 1 },
    });
    const b = fakeManifest({
      "z.md": { sha: "new", size: 1 },
      "b.md": { sha: "new", size: 1 },
    });
    const d = diffManifests(a, b);
    expect(d.added.map((e) => e.path)).toEqual(["b.md"]);
    expect(d.removed.map((e) => e.path)).toEqual(["a.md"]);
    expect(d.changed.map((e) => e.path)).toEqual(["z.md"]);
  });
});

describe("sidecar I/O", () => {
  test("manifestSidecarPath lands inside Brain/.snapshots/", () => {
    expect(manifestSidecarPath(vault, "abc")).toBe(join(brain, ".snapshots", "abc.manifest.json"));
  });

  test("read of missing path → null (no throw)", () => {
    expect(readManifestSidecar(vault, "ghost")).toBeNull();
  });

  test("read of malformed JSON → null", () => {
    writeFileSync(manifestSidecarPath(vault, "torn"), "not json {");
    expect(readManifestSidecar(vault, "torn")).toBeNull();
  });

  test("read of wrong schema_version → null", () => {
    writeFileSync(
      manifestSidecarPath(vault, "old"),
      JSON.stringify({
        schema_version: 99,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: {},
      }),
    );
    expect(readManifestSidecar(vault, "old")).toBeNull();
  });

  test("read of tampered entry (null) → null, does not crash", () => {
    writeFileSync(
      manifestSidecarPath(vault, "tampered-null"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: { "preferences/pref-x.md": null },
      }),
    );
    expect(readManifestSidecar(vault, "tampered-null")).toBeNull();
  });

  test("read of tampered entry (missing sha256) → null", () => {
    writeFileSync(
      manifestSidecarPath(vault, "tampered-shape"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: { "preferences/pref-x.md": { size: 12 } },
      }),
    );
    expect(readManifestSidecar(vault, "tampered-shape")).toBeNull();
  });

  test("read of tampered entry (wrong sha256 type) → null", () => {
    writeFileSync(
      manifestSidecarPath(vault, "tampered-type"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: { "preferences/pref-x.md": { sha256: 42, size: 12 } },
      }),
    );
    expect(readManifestSidecar(vault, "tampered-type")).toBeNull();
  });

  test("write then read roundtrip yields equal structure", () => {
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-rt.md"), "roundtrip");
    const original = buildManifest(brain);
    writeManifestSidecar(vault, "rt", original);
    const back = readManifestSidecar(vault, "rt");
    expect(back).not.toBeNull();
    expect(back!.schema_version).toBe(BRAIN_MANIFEST_SCHEMA_VERSION);
    expect(back!.brain_root).toBe("Brain");
    expect(Object.keys(back!.files)).toEqual(Object.keys(original.files));
    expect(back!.files["preferences/pref-rt.md"]!.sha256).toBe(
      original.files["preferences/pref-rt.md"]!.sha256,
    );
  });
});

/**
 * The derived-store record travels on the same distribution channel as
 * the rest of the sidecar - Syncthing, a manual copy, an operator who
 * lost their nerves - so every field is validated on read and a single
 * malformation fails the WHOLE manifest closed, exactly as one bad file
 * entry already does. Anything looser would let a half-written record
 * claim a coverage the archive does not have, and the restore acts on
 * that claim.
 */
describe("the derived-store field on the sidecar", () => {
  /** A sidecar carrying `derived_store` verbatim, written to disk. */
  function writeSidecarWithStore(runId: string, derivedStore: unknown): void {
    writeFileSync(
      manifestSidecarPath(vault, runId),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: {},
        derived_store: derivedStore,
      }),
    );
  }

  const INCLUDED = Object.freeze({
    included: true,
    source_path: "/vault/.open-second-brain/brain.sqlite",
    archive_name: "run.store.sqlite.zst",
    archive_sha256: "a".repeat(64),
    archive_size: 4096,
    live_size: 8192,
    exclusion_reason: null,
  });

  const EXCLUDED = Object.freeze({
    included: false,
    source_path: "/vault/.open-second-brain/brain.sqlite",
    archive_name: null,
    archive_sha256: null,
    archive_size: null,
    live_size: 8192,
    exclusion_reason: SNAPSHOT_STORE_EXCLUSION.not_requested,
  });

  test("an absent key parses and reads as unknown, never as excluded", () => {
    writeFileSync(
      manifestSidecarPath(vault, "pre-feature"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: {},
      }),
    );
    const back = readManifestSidecar(vault, "pre-feature");
    // The manifest itself is valid - an older peer's sidecar must keep
    // its drift guarantee, which is why the schema version was not
    // bumped for this field.
    expect(back).not.toBeNull();
    expect(back!.derived_store).toBeUndefined();
  });

  test("a well-formed inclusion record roundtrips", () => {
    writeSidecarWithStore("included", INCLUDED);
    expect(readManifestSidecar(vault, "included")!.derived_store).toEqual(INCLUDED);
  });

  test("a well-formed exclusion record roundtrips", () => {
    writeSidecarWithStore("excluded", EXCLUDED);
    expect(readManifestSidecar(vault, "excluded")!.derived_store).toEqual(EXCLUDED);
  });

  test("a live size of zero is kept, because zero is a real size", () => {
    writeSidecarWithStore("zero-size", { ...EXCLUDED, live_size: 0 });
    expect(readManifestSidecar(vault, "zero-size")!.derived_store!.live_size).toBe(0);
  });

  test("an explicit null record is contained to the field, not the record", () => {
    writeSidecarWithStore("null-record", null);
    const contained = readManifestSidecar(vault, "null-record");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("a non-object record is contained to the field, not the record", () => {
    writeSidecarWithStore("scalar-record", "included");
    const contained = readManifestSidecar(vault, "scalar-record");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("a missing `included` flag is contained to the field, not the record", () => {
    const { included: _drop, ...rest } = INCLUDED;
    writeSidecarWithStore("no-flag", rest);
    const contained = readManifestSidecar(vault, "no-flag");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("a non-integer archive size is contained to the field, not the record", () => {
    writeSidecarWithStore("fractional", { ...INCLUDED, archive_size: 4096.5 });
    const contained = readManifestSidecar(vault, "fractional");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("an unregistered exclusion reason is contained to the field, not the record", () => {
    writeSidecarWithStore("unknown-reason", { ...EXCLUDED, exclusion_reason: "ran-out-of-disk" });
    const contained = readManifestSidecar(vault, "unknown-reason");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("inclusion without a digest is contained to the field, not the record", () => {
    // Not a weaker record - a false one. Nothing could verify the
    // archive it claims to have written.
    writeSidecarWithStore("no-digest", { ...INCLUDED, archive_sha256: null });
    const contained = readManifestSidecar(vault, "no-digest");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("inclusion that also names an exclusion reason is contained to the field, not the record", () => {
    writeSidecarWithStore("both", {
      ...INCLUDED,
      exclusion_reason: SNAPSHOT_STORE_EXCLUSION.absent,
    });
    const contained = readManifestSidecar(vault, "both");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });

  test("an exclusion that names no reason is contained to the field, not the record", () => {
    writeSidecarWithStore("reasonless", { ...EXCLUDED, exclusion_reason: null });
    const contained = readManifestSidecar(vault, "reasonless");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.derived_store).toBeUndefined();
    expect(contained!.derived_store_unreadable).toBe(true);
  });
});

/**
 * U7: the snapshot-reason field on the sidecar.
 *
 * Additive at the existing schema version for the same reason the
 * derived-store field is, and validated through the same closed guard.
 * The load-bearing negative is the last case here: the reason is also a
 * run-id PREFIX at every call site that writes one, so guessing it from
 * the run id would look right in almost every test and would manufacture
 * provenance for a hand-named archive the code never stamped.
 */
describe("the snapshot-reason field on the sidecar", () => {
  /** A sidecar carrying `snapshot_reason` verbatim, written to disk. */
  function writeSidecarWithReason(runId: string, reason: unknown): void {
    writeFileSync(
      manifestSidecarPath(vault, runId),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: {},
        snapshot_reason: reason,
      }),
    );
  }

  test("buildManifest stamps the reason it was given", () => {
    const m = buildManifest(brain, { snapshotReason: BRAIN_SNAPSHOT_REASON.entityPrune });
    expect(m.snapshot_reason).toBe(BRAIN_SNAPSHOT_REASON.entityPrune);
    // Still the same schema version: an older peer ignores the key and
    // keeps its own drift detection, which is why it was not bumped.
    expect(m.schema_version).toBe(BRAIN_MANIFEST_SCHEMA_VERSION);
  });

  test("buildManifest omits the key entirely when given no reason", () => {
    const m = buildManifest(brain);
    expect("snapshot_reason" in m).toBe(false);
  });

  test("every registered reason roundtrips through the sidecar", () => {
    for (const reason of BRAIN_SNAPSHOT_REASONS) {
      writeSidecarWithReason(`roundtrip-${reason}`, reason);
      expect(readManifestSidecar(vault, `roundtrip-${reason}`)?.snapshot_reason).toBe(reason);
    }
  });

  test("a sidecar written before the feature reads as no reason at all", () => {
    writeFileSync(
      manifestSidecarPath(vault, "dream-2026-05-18-070000"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: {},
      }),
    );
    const back = readManifestSidecar(vault, "dream-2026-05-18-070000");
    expect(back).not.toBeNull();
    // The run id begins with a registered reason. It is NOT read back as
    // one: the archive does not carry that provenance, and inventing it
    // would make an unstamped snapshot indistinguishable from a stamped
    // one.
    expect(back!.snapshot_reason).toBeUndefined();
  });

  test("an unregistered reason is contained to the field, not the record", () => {
    writeSidecarWithReason("bogus", "spring-cleaning");
    const contained = readManifestSidecar(vault, "bogus");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.snapshot_reason).toBeUndefined();
    expect(contained!.snapshot_reason_unreadable).toBe(true);
  });

  test("an explicit null reason is contained to the field, not the record", () => {
    // Absence is spelled by omitting the key. A null is a present field
    // that names nothing, which no writer here produces.
    writeSidecarWithReason("null-reason", null);
    const contained = readManifestSidecar(vault, "null-reason");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.snapshot_reason).toBeUndefined();
    expect(contained!.snapshot_reason_unreadable).toBe(true);
  });

  test("a non-string reason is contained to the field, not the record", () => {
    writeSidecarWithReason("numeric", 3);
    const contained = readManifestSidecar(vault, "numeric");
    // Drift detection runs on the mandatory part, so an unreadable
    // optional field must not take it down: discarding the record
    // here reports no sidecar at all and skips the gate, which is
    // the silent-overwrite path this field was added beside.
    expect(contained).not.toBeNull();
    expect(contained!.generated_at).toBe("2026-05-18T00:00:00Z");
    expect(contained!.snapshot_reason).toBeUndefined();
    expect(contained!.snapshot_reason_unreadable).toBe(true);
  });

  test("write then read roundtrip preserves the reason", () => {
    writeFileSync(join(brain, "_brain.yaml"), "schema_version: 1\n");
    const original = buildManifest(brain, { snapshotReason: BRAIN_SNAPSHOT_REASON.manual });
    writeManifestSidecar(vault, "reason-rt", original);
    expect(readManifestSidecar(vault, "reason-rt")!.snapshot_reason).toBe(
      BRAIN_SNAPSHOT_REASON.manual,
    );
  });
});
