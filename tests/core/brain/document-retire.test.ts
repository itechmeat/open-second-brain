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
 * The manifest drop is the resurrect guard: with the entry gone, the
 * retired copy's source classifies `new` again, so the system never
 * claims a retired page's records are current and a later ingest can
 * only bring the source back as a deliberate full re-ingest.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  classifyPaths,
  readManifest,
  updateManifest,
} from "../../../src/core/brain/ingest/content-manifest.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  RETIRE_LINKS_SKIPPED_BASENAME_COLLISION,
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
    expect(copy.manifestDropped).toBe(true);
    expect(copy.sourceArchiveHash).toBe(ARCHIVE_HASH);
    expect(copy.auditRecordId).not.toBeNull();

    // The wikilink retarget report, asserted: the citing page matched,
    // was rewritten, and its [[src-b]] now names the canonical spelling.
    expect(copy.wikilinksSkipped).toBeNull();
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

  test("drops the manifest entry round-tripping the read contract", () => {
    const { canonical, retired } = seedPair();
    const fingerprintBefore = readManifest(vault).entries["imports/a.md"]?.fingerprint;

    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });

    const manifest = readManifest(vault);
    expect(manifest.entries["imports/b.md"]).toBeUndefined();
    // The surviving entry keeps the fingerprint it was recorded under -
    // a removal never re-stamps the contract the survivors answered.
    expect(manifest.entries["imports/a.md"]?.fingerprint).toBe(fingerprintBefore);
  });

  test("the manifest drop is the resurrect guard: the retired source classifies new", () => {
    const { canonical, retired } = seedPair();
    retireDocumentCopies(vault, [{ path: retired, canonical }], { agent: "tester", now: NOW });

    const classification = classifyPaths(vault, ["imports/b.md"], readManifest(vault));
    expect(classification.new).toContain("imports/b.md");
    expect(classification.unchanged).not.toContain("imports/b.md");
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

  test("a basename collision skips the link pass and names why", () => {
    // An unrelated page in another namespace shares the retired copy's
    // basename, so the bare [[src-b]] spelling is ambiguous: rewriting it
    // would repoint links that meant the namesake. The copy still retires;
    // the pass is skipped by name and every link stays exactly as it was -
    // a stale link is discoverable, a mis-pointed one misleads silently.
    const { canonical, retired, citing } = seedPair();
    const namesake = "Brain/entities/src-b.md";
    mkdirSync(join(vault, "Brain", "entities"), { recursive: true });
    writeFileSync(join(vault, namesake), "# Src b\n\nThe page the link really means.\n", "utf8");

    const result = retireDocumentCopies(vault, [{ path: retired, canonical }], {
      agent: "tester",
      now: NOW,
    });

    expect(result.failed).toEqual([]);
    const copy = result.retired[0]!;
    expect(copy.path).toBe(retired);
    expect(copy.wikilinks).toBeNull();
    expect(copy.wikilinksSkipped).toBe(RETIRE_LINKS_SKIPPED_BASENAME_COLLISION);
    // The citing page keeps its spelling, the namesake page is untouched,
    // and the retired copy itself is still gone.
    expect(readFileSync(join(vault, citing), "utf8")).toContain("[[src-b]]");
    expect(existsSync(join(vault, namesake))).toBe(true);
    expect(existsSync(join(vault, retired))).toBe(false);
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
      expect(readManifest(vault).entries["imports/b.md"]).toBeUndefined();
      expect(listContinuityRecords(vault, { kind: "source_invalidation" })).toHaveLength(0);
    } finally {
      chmodSync(continuityDir, 0o755);
    }
  });

  test("the per-copy reason words the manifest outcome from what actually happened", () => {
    const { retired } = seedPair();
    retireDocumentCopies(vault, [{ path: retired, canonical: "Brain/sources/src-a.md" }], {
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
    expect(reason).toContain("dropped manifest key imports/b.md");
  });

  test("a shared source_path retires twice: the second drop is named already-absent", () => {
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
    expect(reasons.some((r) => r.includes("dropped manifest key imports/b.md"))).toBe(true);
    expect(reasons.some((r) => r.includes("manifest key imports/b.md already absent"))).toBe(true);
  });

  test("no manifest on disk is named, not claimed as a drop", () => {
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
    expect(reason).not.toContain("dropped manifest key");
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
    expect(reason).not.toContain("dropped manifest key");
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
