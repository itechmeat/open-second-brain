/**
 * C6 (t_edde2198): delete and search by exact source file.
 *
 * When a benchmark file, log, or accidental import pollutes a Brain,
 * operators need to (a) find every derived entry that traces back to an
 * exact source path and (b) surgically remove them, including index
 * artifacts, WITHOUT re-mining the vault or hand-chasing summary pages.
 *
 * The contract:
 *   - `searchBySourceFile` returns only entries derived from that exact
 *     source (frontmatter `source_path` / `session_ref`, a `[[source]]`
 *     wikilink in prose, or a preference evidenced by a derived signal).
 *   - `deleteBySource` is DRY-RUN BY DEFAULT: it reports the blast radius
 *     and deletes NOTHING.
 *   - With `confirm`, derived entries + index artifacts are deleted, but
 *     original user notes are preserved unless `includeOriginals` is set.
 *   - Every confirmed cleanup is auditable (a `source_invalidation`
 *     continuity record is written).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestSource } from "../../../src/core/brain/ingest/ingest.ts";
import { readManifest } from "../../../src/core/brain/ingest/content-manifest.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { deleteBySource, searchBySourceFile } from "../../../src/core/brain/source-cleanup.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";

let vault: string;

const SOURCE = "imports/benchmark.md";
const OTHER_SOURCE = "imports/legit-note.md";
const NOW = new Date("2026-06-01T00:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-source-cleanup-"));
  mkdirSync(join(vault, "imports"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/**
 * Build a realistic contaminated Brain: an ingested source (summary page
 * + entity page), a signal citing the source, a preference evidenced by
 * that signal, plus unrelated material and a shared daily log that merely
 * mentions the source. Returns the derived signal id for assertions.
 */
function seedContaminatedVault(): { signalId: string } {
  // The original imported file itself.
  writeFileSync(join(vault, SOURCE), "benchmark rows\n", "utf8");
  writeFileSync(join(vault, OTHER_SOURCE), "a real note\n", "utf8");

  // Ingest the contaminated source: a summary page (kind: brain-source,
  // source_path === SOURCE) plus an entity page carrying `[[SOURCE]]`
  // provenance.
  ingestSource(
    vault,
    {
      sourcePath: SOURCE,
      summary: "Benchmark import summary.",
      extraction: {
        entities: [{ category: "concept", name: "BenchWidget" }],
      },
    },
    { agent: "tester", now: NOW },
  );

  // Ingest an unrelated legit source so isolation is testable.
  ingestSource(
    vault,
    {
      sourcePath: OTHER_SOURCE,
      summary: "A legitimate note.",
      extraction: { entities: [{ category: "concept", name: "RealThing" }] },
    },
    { agent: "tester", now: NOW },
  );

  // A signal that directly cites the contaminated source.
  const sig = writeSignal(vault, {
    topic: "bench",
    signal: "positive",
    agent: "tester",
    principle: "Derived from the contaminated benchmark import.",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "bench-derived",
    source: [`[[${SOURCE}]]`],
  });

  // An unrelated signal citing the legit source.
  writeSignal(vault, {
    topic: "legit",
    signal: "positive",
    agent: "tester",
    principle: "Derived from a legitimate note.",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "legit-derived",
    source: [`[[${OTHER_SOURCE}]]`],
  });

  // A preference folded from the contaminated signal (transitive).
  writePreference(vault, {
    slug: "bench-pref",
    topic: "bench",
    principle: "A preference folded from the contaminated signal.",
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-06-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [`[[${sig.id}]]`],
  });

  // A shared daily log that merely MENTIONS the source. Deleting the whole
  // log would destroy unrelated lines, so it must be reported, not removed.
  writeFileSync(
    join(vault, "Brain", "log", "2026-06-01.md"),
    `# Log\n\n- ingested [[${SOURCE}]]\n- unrelated line about other work\n`,
    "utf8",
  );

  return { signalId: sig.id };
}

describe("searchBySourceFile — exact source filter", () => {
  test("returns only entries derived from the exact source", () => {
    seedContaminatedVault();
    const hits = searchBySourceFile(vault, SOURCE);
    const paths = hits.map((h) => h.path);

    // The summary page, the entity page, the citing signal, the folded
    // preference, and the mentioning log all trace to the source.
    expect(paths.some((p) => p.startsWith("Brain/sources/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("Brain/entities/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("Brain/inbox/") && p.includes("bench-derived"))).toBe(
      true,
    );
    expect(paths.some((p) => p.startsWith("Brain/preferences/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("Brain/log/"))).toBe(true);

    // Nothing derived from the OTHER source leaks in.
    expect(paths.some((p) => p.includes("legit-derived"))).toBe(false);
    expect(paths.some((p) => p.includes("RealThing") || p.includes("legit-note"))).toBe(false);
  });

  test("an unknown source yields no hits", () => {
    seedContaminatedVault();
    expect(searchBySourceFile(vault, "imports/never-ingested.md")).toEqual([]);
  });
});

describe("deleteBySource — dry-run by default", () => {
  test("with no confirm, reports the blast radius and deletes nothing", () => {
    seedContaminatedVault();
    const plan = deleteBySource(vault, SOURCE, { now: NOW });

    expect(plan.confirmed).toBe(false);
    expect(plan.deleted).toEqual([]);
    expect(plan.blastRadius).toBeGreaterThan(0);
    // Derived entries + at least one index artifact are reported.
    expect(plan.derived.length).toBeGreaterThan(0);
    expect(plan.derived.some((e) => e.isIndexArtifact)).toBe(true);
    // The shared log is reported as a protected mention, not a deletion.
    expect(plan.mentions.some((e) => e.path.startsWith("Brain/log/"))).toBe(true);
    // The original file is reported as an original.
    expect(plan.originals).toContain(SOURCE);
    // Nothing was written: no audit record, no manifest change.
    expect(plan.auditRecordId).toBeNull();
    expect(plan.manifestEntryRemoved).toBe(false);

    // Every referenced file still exists on disk.
    for (const entry of [...plan.derived, ...plan.mentions]) {
      expect(existsSync(join(vault, entry.path))).toBe(true);
    }
    expect(existsSync(join(vault, SOURCE))).toBe(true);
    // No continuity audit record was written.
    expect(listContinuityRecords(vault, { kind: "source_invalidation" })).toEqual([]);
  });
});

describe("deleteBySource — confirmed cleanup", () => {
  test("confirm (no includeOriginals) removes derived + index, preserves originals", () => {
    seedContaminatedVault();
    const plan = deleteBySource(vault, SOURCE, { confirm: true, now: NOW });

    expect(plan.confirmed).toBe(true);
    expect(plan.deleted.length).toBeGreaterThan(0);

    // Derived entries and index artifacts are gone.
    for (const entry of plan.derived) {
      expect(existsSync(join(vault, entry.path))).toBe(false);
    }
    // The manifest entry for the source (an index artifact) is dropped.
    expect(plan.manifestEntryRemoved).toBe(true);
    expect(readManifest(vault).entries[SOURCE]).toBeUndefined();

    // The ORIGINAL imported file is preserved.
    expect(existsSync(join(vault, SOURCE))).toBe(true);
    // The shared log (a protected mention) is preserved.
    expect(existsSync(join(vault, "Brain", "log", "2026-06-01.md"))).toBe(true);
    // Unrelated derived material survives.
    expect(existsSync(join(vault, OTHER_SOURCE))).toBe(true);

    // The cleanup is auditable.
    expect(plan.auditRecordId).not.toBeNull();
    const audit = listContinuityRecords(vault, { kind: "source_invalidation" });
    expect(audit.length).toBe(1);
    expect(audit[0]!.sourceRefs.some((r) => r.id === SOURCE)).toBe(true);
  });

  test("confirm + includeOriginals also removes the original file", () => {
    seedContaminatedVault();
    const plan = deleteBySource(vault, SOURCE, {
      confirm: true,
      includeOriginals: true,
      now: NOW,
    });

    expect(plan.confirmed).toBe(true);
    expect(plan.includeOriginals).toBe(true);
    // The original imported file is removed.
    expect(existsSync(join(vault, SOURCE))).toBe(false);
    expect(plan.deleted).toContain(SOURCE);
    // Unrelated originals are untouched.
    expect(existsSync(join(vault, OTHER_SOURCE))).toBe(true);
    // Still auditable.
    expect(plan.auditRecordId).not.toBeNull();
  });

  test("re-running a confirmed cleanup is a safe no-op (idempotent)", () => {
    seedContaminatedVault();
    deleteBySource(vault, SOURCE, { confirm: true, includeOriginals: true, now: NOW });
    const second = deleteBySource(vault, SOURCE, {
      confirm: true,
      includeOriginals: true,
      now: NOW,
    });
    expect(second.deleted).toEqual([]);
    expect(second.derived).toEqual([]);
    // A no-op confirmed run writes no audit record.
    expect(second.auditRecordId).toBeNull();
  });
});

describe("deleteBySource - D1 snapshot gate", () => {
  test("confirm path snapshots before deleting and reports the recovery point", () => {
    seedContaminatedVault();

    // Learn which derived files will be deleted before running.
    const preview = deleteBySource(vault, SOURCE, { now: NOW });
    const derivedPaths = preview.derived.map((e) => e.path);
    expect(derivedPaths.length).toBeGreaterThan(0);

    const plan = deleteBySource(vault, SOURCE, { confirm: true, now: NOW });

    // The plan carries the recovery point.
    expect(plan.snapshotRunId).not.toBeNull();
    expect(plan.snapshotPath).not.toBeNull();
    expect(existsSync(plan.snapshotPath!)).toBe(true);

    // A snapshot archive exists and is listed by the engine.
    const snaps = listSnapshots(vault);
    expect(snaps.some((s) => s.run_id === plan.snapshotRunId)).toBe(true);

    // The archive is restorable: it contains the files that were deleted.
    const tmp = mkdtempSync(join(tmpdir(), "o2b-src-snap-verify-"));
    try {
      const zstd = spawnSync("zstd", ["-d", "-c", plan.snapshotPath!], {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(zstd.status).toBe(0);
      const tar = spawnSync("tar", ["-x", "-C", tmp], {
        input: zstd.stdout,
        stdio: ["pipe", "inherit", "pipe"],
      });
      expect(tar.status).toBe(0);
      // Every deleted derived path is recoverable from the archive.
      for (const rel of derivedPaths) {
        expect(existsSync(join(tmp, rel))).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dry-run takes NO snapshot", () => {
    seedContaminatedVault();
    const before = listSnapshots(vault).length;
    const plan = deleteBySource(vault, SOURCE, { now: NOW });
    expect(plan.snapshotRunId).toBeNull();
    expect(plan.snapshotPath).toBeNull();
    expect(listSnapshots(vault).length).toBe(before);
  });

  test("confirm with nothing to delete takes NO snapshot (no-op stays a no-op)", () => {
    // A pristine vault with no derived material for this source.
    const before = listSnapshots(vault).length;
    const plan = deleteBySource(vault, "imports/does-not-exist.md", {
      confirm: true,
      now: NOW,
    });
    expect(plan.deleted).toEqual([]);
    expect(plan.snapshotRunId).toBeNull();
    expect(plan.snapshotPath).toBeNull();
    expect(listSnapshots(vault).length).toBe(before);
  });
});

describe("deleteBySource — shared preference via managed _evidenced_by (CR #127.7)", () => {
  test("a wikilink-matched preference evidenced by a FOREIGN signal is reported, never deleted", () => {
    seedContaminatedVault();

    // A signal that derives from the OTHER (legit) source — foreign to SOURCE.
    const foreign = writeSignal(vault, {
      topic: "external",
      signal: "positive",
      agent: "tester",
      principle: "Derived from a legitimate, unrelated source.",
      created_at: "2026-06-01T00:00:00Z",
      date: "2026-06-01",
      slug: "external-derived",
      source: [`[[${OTHER_SOURCE}]]`],
    });

    // A shared preference whose evidence lives in the MANAGED `_evidenced_by`
    // key (points at the foreign signal), and whose body also mentions
    // [[SOURCE]]. It is a shared fold: deleting SOURCE must NOT remove it.
    const sharedPref = join(vault, "Brain", "preferences", "pref-shared-external.md");
    writeFileSync(
      sharedPref,
      `---\nid: pref-shared-external\n_evidenced_by: ["[[${foreign.id}]]"]\n---\n` +
        `A shared preference that also mentions [[${SOURCE}]] in prose.\n`,
      "utf8",
    );

    const plan = deleteBySource(vault, SOURCE, { confirm: true, now: NOW });

    const rel = "Brain/preferences/pref-shared-external.md";
    // It must be reported as a protected mention, not queued for deletion.
    expect(plan.mentions.some((m) => m.path === rel)).toBe(true);
    expect(plan.derived.some((d) => d.path === rel)).toBe(false);
    expect(plan.deleted).not.toContain(rel);
    // And it survives on disk.
    expect(existsSync(sharedPref)).toBe(true);
  });
});
