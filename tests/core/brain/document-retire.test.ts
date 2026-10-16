/**
 * Document retirement applier core (storage lifecycle, Lane 4 task 4.3).
 *
 * Per stale copy the applier must: retarget inbound wikilinks to the
 * canonical, remove the page, drop the content-manifest entry
 * round-tripping the read contract, and append one `source_invalidation`
 * continuity record naming canonical id, retired id, dropped manifest
 * key and the retained source-archive hash. The whole span sits inside
 * the destructive-snapshot gate with a recoverability verdict; the
 * source archive is evidence and stays on disk. Per-copy failures are
 * collected ({path, message}), the failed copy stays on disk, and the
 * run completes.
 *
 * The retired manifest marker is the resurrect guard: the entry stays,
 * marked `retired_into` the canonical page, so the unchanged source
 * classifies `retired` and no batch plan queues it again - while a real
 * content change re-admits it as `modified`, and a deliberate re-ingest
 * re-records the entry without the marker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { planBatches } from "../../../src/core/brain/ingest/batch-plan.ts";
import {
  classifyPaths,
  readManifest,
  updateManifest,
} from "../../../src/core/brain/ingest/content-manifest.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  RETIRE_BASENAME_COLLISION_REFUSAL,
  retireDocumentCopies,
} from "../../../src/core/brain/document-retire.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let vault: string;

const NOW = new Date("2026-06-01T00:00:00Z");
const ARCHIVE_HASH = "b".repeat(64);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-document-retire-"));
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  mkdirSync(join(vault, "imports"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const CANONICAL_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces weekly";
const DUPLICATE_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces daily";

interface PageOptions {
  readonly body: string;
  readonly sourcePath: string;
  readonly createdAt: string;
  readonly archiveHash?: string;
}

/** Write one ingest summary page; returns its vault-relative path. */
function writeSourcePage(slug: string, opts: PageOptions): string {
  const lines = [
    "---",
    "kind: brain-source",
    `source_path: ${opts.sourcePath}`,
    `source_hash: ${"a".repeat(64)}`,
  ];
  if (opts.archiveHash !== undefined) {
    lines.push(`source_archive_hash: ${opts.archiveHash}`, "source_archive_bytes: 24");
  }
  lines.push("tags: [brain, brain/source]", `created_at: ${opts.createdAt}`, "---", "");
  lines.push(opts.body, "", "## Sources", "", `- [[${opts.sourcePath}]]`, "");
  const abs = join(vault, "Brain", "sources", `src-${slug}.md`);
  writeFileSync(abs, lines.join("\n"), "utf8");
  return `Brain/sources/src-${slug}.md`;
}

/**
 * Build the near-duplicate pair: canonical src-a and stale src-b, both
 * ingested (manifest entries recorded), plus a citing page whose
 * `[[src-b]]` link must be retargeted, and the durable source archive
 * for the stale copy's source.
 */
function seedPair(): { canonical: string; retired: string; citing: string } {
  writeFileSync(join(vault, "imports", "a.md"), "canonical source bytes\n", "utf8");
  writeFileSync(join(vault, "imports", "b.md"), "duplicate source bytes\n", "utf8");
  const canonical = writeSourcePage("a", {
    body: CANONICAL_BODY,
    sourcePath: "imports/a.md",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const retired = writeSourcePage("b", {
    body: DUPLICATE_BODY,
    sourcePath: "imports/b.md",
    createdAt: "2026-02-01T00:00:00Z",
    archiveHash: ARCHIVE_HASH,
  });
  updateManifest(vault, ["imports/a.md", "imports/b.md"]);
  const citing = "Brain/note.md";
  writeFileSync(
    join(vault, citing),
    "# Note\n\nSee [[src-b]] for the duplicate and [[imports/a]] for the original.\n",
    "utf8",
  );
  mkdirSync(join(vault, "Brain", ".archives"), { recursive: true });
  writeFileSync(join(vault, "Brain", ".archives", `${ARCHIVE_HASH}.txt`), "redacted bytes", "utf8");
  return { canonical, retired, citing };
}

describe("retireDocumentCopies", () => {
  test("retires a stale copy end to end behind the snapshot gate", () => {
    const { canonical, retired, citing } = seedPair();
    const before = readFileSync(join(vault, citing), "utf8");

    const result = retireDocumentCopies(vault, [{ path: retired, canonical }], {
      agent: "tester",
      now: NOW,
    });

    expect(result.failed).toEqual([]);
    expect(result.retired).toHaveLength(1);
    const copy = result.retired[0]!;
    expect(copy.path).toBe(retired);
    expect(copy.canonical).toBe(canonical);
    expect(copy.manifestKey).toBe("imports/b.md");
    expect(copy.manifestRetired).toBe(true);
    expect(copy.sourceArchiveHash).toBe(ARCHIVE_HASH);
    expect(copy.auditRecordId).not.toBeNull();

    // The wikilink retarget report, asserted: the citing page matched,
    // was rewritten, and its [[src-b]] now names the canonical spelling.
    expect(copy.wikilinks!.matched).toEqual([citing]);
    expect(copy.wikilinks!.rewritten).toEqual([citing]);
    expect(copy.wikilinks!.failed).toEqual([]);
    expect(readFileSync(join(vault, citing), "utf8")).toContain("[[src-a]]");
    expect(readFileSync(join(vault, citing), "utf8")).not.toBe(before);

    // The stale page is gone; the canonical page survives.
    expect(existsSync(join(vault, retired))).toBe(false);
    expect(existsSync(join(vault, canonical))).toBe(true);

    // The whole span sat behind the snapshot gate with a verdict.
    expect(result.snapshotRunId).not.toBeNull();
    expect(result.snapshotPath).not.toBeNull();
    expect(existsSync(result.snapshotPath!)).toBe(true);
    expect(result.recoverability.state).toBe("covered");
  });

  test("marks the manifest entry retired, round-tripping the read contract", () => {
    const { canonical, retired } = seedPair();
    const before = readManifest(vault).entries["imports/b.md"];
    const fingerprintBefore = readManifest(vault).entries["imports/a.md"]?.fingerprint;

    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });

    const manifest = readManifest(vault);
    // The entry STAYS, marked retired into the canonical page - the
    // resurrect guard. Dropping it would re-admit the unchanged source.
    expect(manifest.entries["imports/b.md"]?.retired_into).toBe(canonical);
    // The digest and fingerprint the entry was recorded under survive.
    expect(manifest.entries["imports/b.md"]?.sha256).toBe(before?.sha256);
    expect(manifest.entries["imports/b.md"]?.fingerprint).toBe(before?.fingerprint);
    // The surviving entry keeps the fingerprint it was recorded under -
    // a retirement never re-stamps the contract the survivors answered.
    expect(manifest.entries["imports/a.md"]?.fingerprint).toBe(fingerprintBefore);
  });

  test("the retired marker is the resurrect guard: a batch plan never queues the retired source", () => {
    const { canonical, retired } = seedPair();
    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });

    // The unchanged source classifies `retired`, never `new`.
    const classification = classifyPaths(vault, ["imports/b.md"], readManifest(vault));
    expect(classification.retired).toContain("imports/b.md");
    expect(classification.new).not.toContain("imports/b.md");
    expect(classification.unchanged).not.toContain("imports/b.md");

    // A batch plan over the folder does not queue the retired source.
    const plan = planBatches(vault, "imports", { maxBatchBytes: 1024 * 1024, maxBatchFiles: 100 });
    const queued = plan.batches.flatMap((b) => b.files.map((f) => f.path));
    expect(queued).not.toContain("imports/b.md");
    expect(plan.skippedRetired).toContain("imports/b.md");

    // A real content change re-admits it: the bytes moved, so the copy
    // classifies `modified` and the plan queues it again.
    writeFileSync(join(vault, "imports", "b.md"), "changed duplicate source bytes\n", "utf8");
    const after = classifyPaths(vault, ["imports/b.md"], readManifest(vault));
    expect(after.modified).toContain("imports/b.md");
    expect(after.retired).not.toContain("imports/b.md");
    const changedPlan = planBatches(vault, "imports", {
      maxBatchBytes: 1024 * 1024,
      maxBatchFiles: 100,
    });
    expect(changedPlan.batches.flatMap((b) => b.files.map((f) => f.path))).toContain(
      "imports/b.md",
    );
  });

  test("a deliberate re-ingest re-admits the retired source", () => {
    const { canonical, retired } = seedPair();
    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });

    // A deliberate full re-ingest re-records the entry without the marker
    // (updateManifest is the post-ingest write), and the source classifies
    // `unchanged` again - the retirement claimed the records, not the file.
    updateManifest(vault, ["imports/b.md"]);
    const classification = classifyPaths(vault, ["imports/b.md"], readManifest(vault));
    expect(classification.unchanged).toContain("imports/b.md");
    expect(classification.retired).not.toContain("imports/b.md");
  });

  test("appends one source_invalidation record per copy naming the provenance", () => {
    const { canonical, retired } = seedPair();
    const recordsBefore = listContinuityRecords(vault, { kind: "source_invalidation" }).length;

    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });

    const records = listContinuityRecords(vault, { kind: "source_invalidation" });
    expect(records.length).toBe(recordsBefore + 1);
    const record = records.at(-1)!;
    expect(record.id).not.toBeNull();
    const reason = String((record.payload as Record<string, unknown>)["reason"]);
    expect(reason).toContain("src-a");
    expect(reason).toContain("src-b");
    expect(reason).toContain("imports/b.md");
    expect(reason).toContain(ARCHIVE_HASH);
  });

  test("the retained source archive is still on disk after the run", () => {
    const { canonical, retired } = seedPair();
    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });
    expect(existsSync(join(vault, "Brain", ".archives", `${ARCHIVE_HASH}.txt`))).toBe(true);
  });

  test("the result reports the snapshot bytes and the net disk delta", () => {
    // Review M6 (retire half): the destructive span archives Brain/ into a
    // COUNTED surface (.snapshots) before it frees anything, so a result
    // carrying only removal counts hides that the vault can GROW. The
    // result carries the page bytes measured before the removal, the
    // snapshot archive's bytes, and the net between them.
    const { canonical, retired } = seedPair();
    const pageBytes = statSync(join(vault, retired)).size;

    const result = retireDocumentCopies(vault, [{ path: retired, canonical }], {
      agent: "tester",
      now: NOW,
    });

    expect(result.retired[0]!.pageBytes).toBe(pageBytes);
    expect(result.disk.removedBytes).toBe(pageBytes);
    expect(result.disk.snapshotBytes).toBe(statSync(result.snapshotPath!).size);
    expect(result.disk.netBytes).toBe((result.disk.snapshotBytes ?? 0) - pageBytes);
  });

  test("a per-copy failure is collected, the copy stays on disk, and the run completes", () => {
    const { canonical, retired } = seedPair();
    const missing = "Brain/sources/src-gone.md";

    const result = retireDocumentCopies(
      vault,
      [
        { path: missing, canonical },
        { path: retired, canonical },
      ],
      { agent: "tester", now: NOW },
    );

    expect(result.retired.map((r) => r.path)).toEqual([retired]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe(missing);
    expect(result.failed[0]!.message.length).toBeGreaterThan(0);
    // The run completed behind one snapshot span covering the copies.
    expect(result.snapshotRunId).not.toBeNull();
  });

  test("a basename collision refuses the copy and keeps it on disk", () => {
    // An unrelated page in another namespace shares the retired copy's
    // basename, so the bare [[src-b]] spelling is ambiguous: rewriting it
    // would repoint links that meant the namesake, and removing the page
    // anyway would re-point every leftover [[src-b]] at the namesake
    // SILENTLY - resolved by a deletion, never confirmed by an editor.
    // The copy is refused per copy and stays on disk instead (review L5);
    // the stale link stays exactly as visible as it was.
    const { canonical, retired, citing } = seedPair();
    const namesake = "Brain/entities/src-b.md";
    mkdirSync(join(vault, "Brain", "entities"), { recursive: true });
    writeFileSync(join(vault, namesake), "# Src b\n\nThe page the link really means.\n", "utf8");

    const result = retireDocumentCopies(vault, [{ path: retired, canonical }], {
      agent: "tester",
      now: NOW,
    });

    expect(result.retired).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe(retired);
    expect(result.failed[0]!.message).toContain(RETIRE_BASENAME_COLLISION_REFUSAL);
    // Nothing moved: the retired page, the namesake page, the citing
    // spelling, and the audit.
    expect(existsSync(join(vault, retired))).toBe(true);
    expect(existsSync(join(vault, namesake))).toBe(true);
    expect(readFileSync(join(vault, citing), "utf8")).toContain("[[src-b]]");
    expect(listContinuityRecords(vault, { kind: "source_invalidation" })).toHaveLength(0);
  });

  test("a failed inbound-link rewrite keeps the copy in place", () => {
    if (CHMOD_CANNOT_DENY) return;
    // One citing page sits in a directory this run cannot write: the
    // retarget report collects the write failure without throwing, and
    // retiring the copy over it would strand exactly the link the pass
    // could not repoint. The refusal comes BEFORE the removal, so the
    // copy stays on disk (review M7).
    const { canonical, retired } = seedPair();
    rmSync(join(vault, "Brain", "note.md"));
    mkdirSync(join(vault, "Brain", "links"), { recursive: true });
    writeFileSync(join(vault, "Brain", "links", "note.md"), "See [[src-b]] here.\n", "utf8");
    const linksDir = join(vault, "Brain", "links");
    chmodSync(linksDir, 0o555);
    try {
      const result = retireDocumentCopies(vault, [{ path: retired, canonical }], {
        agent: "tester",
        now: NOW,
      });

      expect(result.retired).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.path).toBe(retired);
      // The failure names the file whose rewrite did not land.
      expect(result.failed[0]!.message).toContain("links/note.md");
      // The copy is still on disk; nothing was claimed as retired.
      expect(existsSync(join(vault, retired))).toBe(true);
      expect(listContinuityRecords(vault, { kind: "source_invalidation" })).toHaveLength(0);
    } finally {
      chmodSync(linksDir, 0o755);
    }
  });

  test("a copy whose canonical page is missing is refused per copy", () => {
    const { retired } = seedPair();
    const result = retireDocumentCopies(
      vault,
      [{ path: retired, canonical: "Brain/sources/src-missing.md" }],
      { agent: "tester", now: NOW },
    );
    expect(result.retired).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe(retired);
    expect(existsSync(join(vault, retired))).toBe(true);
  });

  test("a page that is not an ingest summary is refused per copy", () => {
    const { canonical, retired } = seedPair();
    writeFileSync(
      join(vault, "Brain", "sources", "src-nota-000000000000.md"),
      "---\nkind: brain-preference\n---\n\nnot a summary\n",
      "utf8",
    );
    const result = retireDocumentCopies(
      vault,
      [{ path: "Brain/sources/src-nota-000000000000.md", canonical }],
      { agent: "tester", now: NOW },
    );
    expect(result.retired).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(vault, retired))).toBe(true);
  });

  test("retiring the canonical page itself is a caller bug and refuses loudly", () => {
    const { canonical } = seedPair();
    expect(() =>
      retireDocumentCopies(vault, [{ path: canonical, canonical }], { agent: "t", now: NOW }),
    ).toThrow(/canonical/);
  });

  test("no copies means no snapshot and nothing at risk", () => {
    const result = retireDocumentCopies(vault, [], { agent: "tester", now: NOW });
    expect(result.retired).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.snapshotRunId).toBeNull();
    expect(result.recoverability.state).toBe("nothing_at_risk");
  });

  test("a failure AFTER the removal reports the copy as removed, not on disk", () => {
    if (CHMOD_CANNOT_DENY) return;
    const { canonical, retired } = seedPair();
    // The continuity append is the LAST step, after the page is gone:
    // a read-only continuity directory fails exactly that step.
    const continuityDir = join(vault, "Brain", "log", "continuity");
    mkdirSync(continuityDir, { recursive: true });
    chmodSync(continuityDir, 0o555);
    try {
      const result = retireDocumentCopies(vault, [{ path: retired, canonical }], {
        agent: "tester",
        now: NOW,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.path).toBe(retired);
      expect(result.failed[0]!.message).toContain("removed");
      expect(result.failed[0]!.message).toContain(retired);
      // The honest half of the old claim: the page is NOT on disk.
      expect(existsSync(join(vault, retired))).toBe(false);
      // The steps before the failure did land.
      expect(readManifest(vault).entries["imports/b.md"]?.retired_into).toBe(canonical);
      expect(listContinuityRecords(vault, { kind: "source_invalidation" })).toHaveLength(0);
    } finally {
      chmodSync(continuityDir, 0o755);
    }
  });

  test("the per-copy reason words the manifest outcome from what actually happened", () => {
    const { canonical, retired } = seedPair();
    retireDocumentCopies(vault, [{ path: retired, canonical }], {
      agent: "tester",
      now: NOW,
    });
    const reason = String(
      (
        listContinuityRecords(vault, { kind: "source_invalidation" }).at(-1)!.payload as Record<
          string,
          unknown
        >
      )["reason"],
    );
    expect(reason).toContain(`marked manifest key imports/b.md retired into ${canonical}`);
  });

  test("a shared source_path retires twice: the second marker is named already-marked", () => {
    const { canonical } = seedPair();
    // A second copy declaring the SAME source_path as the first copy's.
    const second = writeSourcePage("b2", {
      body: DUPLICATE_BODY,
      sourcePath: "imports/b.md",
      createdAt: "2026-02-02T00:00:00Z",
    });
    const result = retireDocumentCopies(
      vault,
      [
        { path: second, canonical },
        { path: "Brain/sources/src-b.md", canonical },
      ],
      { agent: "tester", now: NOW },
    );
    expect(result.failed).toEqual([]);
    const reasons = listContinuityRecords(vault, { kind: "source_invalidation" }).map((r) =>
      String((r.payload as Record<string, unknown>)["reason"]),
    );
    expect(reasons.some((r) => r.includes(`marked manifest key imports/b.md retired`))).toBe(true);
    // The second retirement marks the SAME key into the SAME canonical, so
    // the bytes are already identical and the clause names that fact.
    expect(
      reasons.some((r) => r.includes("manifest key imports/b.md already marked retired")),
    ).toBe(true);
  });

  test("no manifest on disk is named, not claimed as a marker", () => {
    const { canonical, retired } = seedPair();
    rmSync(join(vault, ".open-second-brain", "ingest-manifest.json"));
    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });
    const reason = String(
      (
        listContinuityRecords(vault, { kind: "source_invalidation" }).at(-1)!.payload as Record<
          string,
          unknown
        >
      )["reason"],
    );
    expect(reason).toContain("manifest");
    expect(reason).toContain("imports/b.md");
    expect(reason).not.toContain("marked manifest key");
  });

  test("a copy with no recorded source_path names the absence, not a drop", () => {
    const { canonical } = seedPair();
    const keyless = writeSourcePage("keyless", {
      body: DUPLICATE_BODY,
      sourcePath: "",
      createdAt: "2026-02-03T00:00:00Z",
    });
    retireDocumentCopies(vault, [{ path: keyless, canonical }], { agent: "tester", now: NOW });
    const reason = String(
      (
        listContinuityRecords(vault, { kind: "source_invalidation" }).at(-1)!.payload as Record<
          string,
          unknown
        >
      )["reason"],
    );
    expect(reason).toContain("no manifest key recorded");
    expect(reason).not.toContain("marked manifest key");
  });

  test("a copy path that escapes the vault is refused as a containment breach, not a vanish", () => {
    // A hand-built plan naming a path outside the vault: the file exists at
    // the escaped location and looks like a retireable summary, so the run
    // used to reach the removal and report the shared removeFile `false` as
    // "vanished before removal" - a disappearance that never happened. The
    // refusal is named for what it is, and the outside file is untouched.
    // The escaped sibling sits outside the vault temp dir the afterEach
    // removes, so it carries the run's unique suffix and cleans up itself.
    const { canonical } = seedPair();
    const escaped = join("..", `escaped-${basename(vault)}.md`);
    writeFileSync(
      join(vault, escaped),
      [
        "---",
        "kind: brain-source",
        "source_path: imports/b.md",
        `source_hash: ${"a".repeat(64)}`,
        "---",
        "",
        DUPLICATE_BODY,
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = retireDocumentCopies(vault, [{ path: escaped, canonical }], {
        agent: "tester",
        now: NOW,
      });

      expect(result.retired).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.path).toBe(escaped);
      expect(result.failed[0]!.message).toContain("escapes the vault");
      expect(result.failed[0]!.message).not.toContain("vanished");
      expect(existsSync(join(vault, escaped))).toBe(true);
    } finally {
      rmSync(join(vault, escaped));
    }
  });
});
