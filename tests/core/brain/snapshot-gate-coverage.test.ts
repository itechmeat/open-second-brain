/**
 * B1: the four operations with the largest unprotected blast radius.
 *
 * The defects, one per section below.
 *
 *   1. `restoreSnapshot` deletes every live top-level entry under
 *      `Brain/` and takes no recovery point of what it discards. An
 *      operator who rolls back to the wrong run id has no way back at
 *      all - the confirmation ladder in front of it is the strongest in
 *      the codebase, which makes the missing recovery point the one weak
 *      link in an otherwise careful verb.
 *   2. The dream pass calls `createSnapshot` inline. The gate's own
 *      header names that as the anti-pattern it exists to prevent: a
 *      second path that has to be kept correct by hand.
 *   3. `pruneSnapshots` destroys recovery points on every snapshot and
 *      every dream, with no gate, no confirmation and no report. Its own
 *      comment calls it "the most destructive operation in the module",
 *      and a configured retention of zero silently removed every archive
 *      in the vault.
 *   4. `deleteBySource --include-originals` reported a `snapshotRunId`
 *      and a `snapshotPath` for a deletion the archive does not cover:
 *      an original is only ever returned when it lies OUTSIDE `Brain/`,
 *      and the archive holds `Brain/` and nothing else.
 *
 * What this file deliberately does NOT cover:
 *
 *   - the confirmation ladder in front of any of them. Whether
 *     `rollback` demands `--yes`, and whether `deleteBySource` is
 *     dry-run by default, are `rollback.test.ts`'s and
 *     `source-cleanup.test.ts`'s questions and are unchanged here.
 *   - archive CONTENT. That the tar round-trips is
 *     `brain.snapshot.test.ts`'s subject; this file asks only whether a
 *     recovery point EXISTS at the moment the bytes go.
 *   - dream's planning. The byte-identity measurement below covers the
 *     whole tree precisely so it does not have to enumerate what dream
 *     writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import {
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  SNAPSHOT_PRUNE_REFUSAL,
  SNAPSHOT_RETENTION_FLOOR,
} from "../../../src/core/brain/snapshot.ts";
import { restoreSnapshotWithRecoveryPoint } from "../../../src/core/brain/snapshot-gate.ts";
import { deleteBySource } from "../../../src/core/brain/source-cleanup.ts";
import { ingestSource } from "../../../src/core/brain/ingest/ingest.ts";
import {
  RECOVERABILITY_BLOCKER,
  RECOVERABILITY_STATE,
  RECOVERY_COVERAGE,
} from "../../../src/core/brain/gates/recoverability.ts";
import { brainDirs, dreamWorkrunPath } from "../../../src/core/brain/paths.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-01T00:00:00Z");

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-b1-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-b1-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * One digest over everything a dream pass wrote under `Brain/`, with the
 * five values that were never byte-reproducible in ANY release taken
 * out. Each exclusion is a measured fact, not a convenience - three
 * whole files first:
 *
 *   - `.snapshots/` holds compressed tar archives whose bytes carry the
 *     mtimes of every file in them.
 *   - `vault-id.json` is minted per bootstrap, and its bytes ride into
 *     the daily log's filename shard - so the shard is normalised out of
 *     the PATH too, or two runs would differ by a filename alone.
 *   - `log/dream-runs/` is the workrun journal, whose `at` fields are
 *     wall clock by contract. Its phase ORDER is asserted separately,
 *     because that is the part a crashed pass is reconstructed from.
 *
 * And two values inside the content: `vault_name`, which is the vault
 * directory's own basename and so differs for every temp fixture, and
 * the `size_bytes` of the archive the pass took, which moves with the
 * vault id above.
 *
 * This is `tests/helpers/vault-digest.ts` with those five holes in it.
 * Everything else - every preference, every log line, every move - is
 * compared byte for byte.
 */
function dreamOutputDigest(brainRoot: string): string {
  return createHash("sha256").update(dreamOutputRows(brainRoot).join("\n")).digest("hex");
}

function dreamOutputRows(brainRoot: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(brainRoot, abs).split(sep).join("/");
      if (rel.startsWith(".snapshots/") || rel.startsWith("log/dream-runs/")) continue;
      if (rel === "vault-id.json") continue;
      // `_brain.yaml` is bootstrap output, not dream output - the pass
      // reads it and nothing writes the decision back (`dream.ts:194`).
      // It was inside this digest until a release that added commented
      // config keys moved the number without touching a single byte the
      // pass authored, which is a false alarm on a guard whose whole
      // value is that it never fires falsely. Verified before excluding:
      // with the config file out, main and this branch produce identical
      // rows for every other file.
      if (rel === "_brain.yaml") continue;
      const path = rel.replace(/^log\/(\d{4}-\d{2}-\d{2})\.[0-9a-f]{8}\./, "log/$1.");
      const text = readFileSync(abs, "utf8")
        .replace(/^vault_name: .*$/gm, "vault_name: <name>")
        .replace(/^- size_bytes: \d+$/gm, "- size_bytes: <n>")
        .replace(/"size_bytes":"\d+"/g, String.raw`"size_bytes":"<n>"`);
      rows.push(`${path}\t${createHash("sha256").update(text).digest("hex")}`);
    }
  };
  walk(brainRoot);
  return rows.toSorted();
}

/** A signal in the inbox, which is what gives a dream pass work to do. */
function seedSignal(slug: string): void {
  writeFileSync(
    join(brainDirs(vault).inbox, `sig-2026-05-14-${slug}.md`),
    `---\nkind: brain-signal\nid: sig-2026-05-14-${slug}\ntopic: ${slug}\nsignal: positive\n` +
      `principle: keep ${slug} tidy\ncreated_at: 2026-05-14T00:00:00Z\nagent: tester\n` +
      `---\n\n## Raw\n\nseed\n`,
    "utf8",
  );
}

// ----- 1. restoreSnapshot ---------------------------------------------------

describe("a rollback keeps what it discards", () => {
  test("the live tree is archived before it is deleted, and survives the restore", () => {
    createSnapshot(vault, "manual-baseline", { reason: BRAIN_SNAPSHOT_REASON.manual, now: NOW });

    // Diverge the live tree from the archive. This file exists ONLY in
    // the live tree, so it is exactly what a rollback destroys.
    const doomed = join(brainDirs(vault).inbox, "sig-2026-05-20-only-live.md");
    writeFileSync(doomed, "---\nkind: brain-signal\n---\n\n## Raw\n\nlive only\n", "utf8");

    const out = restoreSnapshotWithRecoveryPoint(vault, "manual-baseline", { now: NOW });

    expect(existsSync(doomed)).toBe(false);
    expect(out.recoverability.state).toBe(RECOVERABILITY_STATE.covered);
    expect(out.recoverability.coverage).toEqual([RECOVERY_COVERAGE.brainTopLevel]);

    // The producerless reason gets its first producer, and the archive
    // it minted is still on disk: `.snapshots/` is excluded from the
    // restore's deletion, which is what makes this recoverable at all.
    expect(out.recoveryPoint.runId.startsWith(BRAIN_SNAPSHOT_REASON.manual)).toBe(true);
    expect(existsSync(out.recoveryPoint.path)).toBe(true);
    expect(listSnapshots(vault).snapshots.map((s) => s.run_id)).toContain(out.recoveryPoint.runId);
  });

  test("the recovery point is taken after extraction, so a corrupt archive mints nothing", () => {
    // Ordering matters: a rollback that cannot read its target must not
    // leave an archive of a tree it never touched.
    const before = listSnapshots(vault).snapshots.length;
    expect(() => restoreSnapshotWithRecoveryPoint(vault, "manual-absent", { now: NOW })).toThrow();
    expect(listSnapshots(vault).snapshots.length).toBe(before);
  });

  test("a direct restore says it proved nothing rather than staying silent", () => {
    createSnapshot(vault, "manual-direct", { reason: BRAIN_SNAPSHOT_REASON.manual, now: NOW });
    const result = restoreSnapshot(vault, "manual-direct");
    expect(result.recoverability.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(result.recoverability.blockers).toContain(RECOVERABILITY_BLOCKER.noRecoveryPoint);
  });
});

// ----- 2. The dream pass ----------------------------------------------------

describe("the dream pass runs behind the gate, not beside it", () => {
  test("dream output over the fixture vault is the digest the previous release produced", () => {
    // MEASURED, not asserted. The literal below was computed by running
    // this exact fixture against the tree WITHOUT this unit and pasted
    // here; it then had to keep matching with the unit applied. A
    // recomputed expectation would prove nothing at all.
    //
    // Re-measured once, in nothing-runs-unwatched, when `_brain.yaml`
    // left the row set: the digest had moved because a commented config
    // key made the bootstrapped template longer, which is not a byte the
    // pass authored. The replacement literal was taken from `main` with
    // the same exclusion applied, and this branch reproduces it - so it
    // is still a number from a tree without the units it guards, not a
    // number this branch invented about itself.
    seedSignal("tidy");
    dream(vault, { now: NOW, agentName: "tester" });
    expect(dreamOutputDigest(join(vault, "Brain"))).toBe(
      "1944a3340e6aee531205e0e3042ca957b23cb67a9254d10b649d49a51e504446",
    );
  });

  test("the workrun phase sequence is unchanged, which is the part with meaning", () => {
    // The workrun journal is excluded from the digest above because its
    // timestamps are wall clock. Its ORDER is not: it is the record a
    // crashed pass is reconstructed from, and moving the snapshot onto
    // the gate moved the point at which the journal opens.
    seedSignal("tidy");
    const summary = dream(vault, { now: NOW, agentName: "tester" });
    const journal = readFileSync(dreamWorkrunPath(vault, summary.run_id), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { phase: string }).phase);
    expect(journal).toEqual([
      "started",
      "cluster_complete",
      "close_complete",
      "promote_complete",
      "synthesize_complete",
      "retire_complete",
      "heal_complete",
      "reconcile_complete",
      "finalized",
    ]);
  });

  test("the archive still carries the dream run id, not a second id of its own", () => {
    seedSignal("tidy");
    const summary = dream(vault, { now: NOW, agentName: "tester" });
    const ids = listSnapshots(vault).snapshots.map((s) => s.run_id);
    expect(ids).toContain(summary.run_id);
    // Exactly one archive per run. A gate that minted its own id beside
    // dream's would leave two, and the workrun would name neither.
    expect(ids.filter((id) => id.startsWith(BRAIN_SNAPSHOT_REASON.dream)).length).toBe(1);
  });

  test("a run id already taken by a workrun is laddered past, as it was before", () => {
    // The dream run id has to be free in the snapshot directory AND the
    // workrun directory; the gate's collision ladder is now the only one.
    seedSignal("tidy");
    const taken = dreamWorkrunPath(vault, `${BRAIN_SNAPSHOT_REASON.dream}-2026-06-01-000000`);
    mkdirSync(dirname(taken), { recursive: true });
    writeFileSync(taken, "", "utf8");

    const summary = dream(vault, { now: NOW, agentName: "tester" });
    expect(summary.run_id).toBe(`${BRAIN_SNAPSHOT_REASON.dream}-2026-06-01-000000-2`);
  });

  test("a dry run still takes no snapshot at all", () => {
    seedSignal("tidy");
    dream(vault, { now: NOW, dryRun: true, agentName: "tester" });
    expect(listSnapshots(vault).snapshots).toEqual([]);
  });
});

// ----- 3. pruneSnapshots ----------------------------------------------------

describe("the prune has a floor and says what it did", () => {
  function seedArchives(count: number): void {
    for (let i = 1; i <= count; i++) {
      createSnapshot(vault, `manual-seed-${i}`, {
        reason: BRAIN_SNAPSHOT_REASON.manual,
        now: new Date(NOW.getTime() + i * 1000),
      });
    }
  }

  test("a retention below the floor is refused by name, not obeyed", () => {
    seedArchives(3);
    const result = pruneSnapshots(vault, 0);
    expect(result.refusal).toBe(SNAPSHOT_PRUNE_REFUSAL.belowRetentionFloor);
    expect(result.deleted).toEqual([]);
    // The whole point: the archives are still there.
    expect(listSnapshots(vault).snapshots.length).toBe(3);
  });

  test("the floor is the smallest retention that keeps a way back", () => {
    expect(SNAPSHOT_RETENTION_FLOOR).toBe(1);
    seedArchives(3);
    const result = pruneSnapshots(vault, SNAPSHOT_RETENTION_FLOOR);
    expect(result.refusal).toBeNull();
    expect(result.deleted.length).toBe(2);
    expect(result.retained).toBe(1);
  });

  test("what it removed is reported rather than trimmed in silence", () => {
    seedArchives(3);
    const result = pruneSnapshots(vault, 2);
    expect(result.deleted.length).toBe(1);
    expect(result.retained).toBe(2);
    expect(result.failed).toEqual([]);
  });

  test("a prune with nothing to do reports nothing removed and no refusal", () => {
    seedArchives(2);
    const result = pruneSnapshots(vault, 10);
    expect(result).toEqual({ deleted: [], failed: [], retained: 2, refusal: null });
  });
});

// ----- 4. deleteBySource --include-originals --------------------------------

describe("delete-by-source stops overclaiming its recovery point", () => {
  function seedSource(): void {
    mkdirSync(join(vault, "imports"), { recursive: true });
    writeFileSync(join(vault, "imports", "benchmark.md"), "benchmark rows\n", "utf8");
    ingestSource(
      vault,
      {
        sourcePath: "imports/benchmark.md",
        summary: "Benchmark import summary.",
        extraction: { entities: [{ category: "concept", name: "BenchWidget" }] },
      },
      { agent: "tester", now: NOW },
    );
  }

  test("without --include-originals the archive really does cover the deletion", () => {
    seedSource();
    const plan = deleteBySource(vault, "imports/benchmark.md", { confirm: true, now: NOW });
    expect(plan.recoverability.state).toBe(RECOVERABILITY_STATE.covered);
    expect(plan.recoverability.blockers).toEqual([]);
    expect(existsSync(join(vault, "imports", "benchmark.md"))).toBe(true);
  });

  test("with --include-originals it names the bytes no archive holds", () => {
    seedSource();
    const plan = deleteBySource(vault, "imports/benchmark.md", {
      confirm: true,
      includeOriginals: true,
      now: NOW,
    });
    // The original is gone and it was never in an archive.
    expect(existsSync(join(vault, "imports", "benchmark.md"))).toBe(false);
    expect(plan.recoverability.state).toBe(RECOVERABILITY_STATE.partial);
    expect(plan.recoverability.coverage).toEqual([RECOVERY_COVERAGE.brainTopLevel]);
    expect(plan.recoverability.blockers).toEqual([RECOVERABILITY_BLOCKER.outsideBrainRoot]);
    // The recovery point is still reported: the verdict qualifies it
    // rather than replacing it.
    expect(plan.snapshotRunId).not.toBeNull();
  });

  test("a dry run promises nothing, because it destroys nothing", () => {
    seedSource();
    const plan = deleteBySource(vault, "imports/benchmark.md", { includeOriginals: true });
    expect(plan.recoverability.state).toBe(RECOVERABILITY_STATE.nothingAtRisk);
    expect(plan.snapshotRunId).toBeNull();
  });

  test("a confirmed run with no work reports nothing at risk, not a lost archive", () => {
    const plan = deleteBySource(vault, "imports/absent.md", { confirm: true, now: NOW });
    expect(plan.recoverability.state).toBe(RECOVERABILITY_STATE.nothingAtRisk);
    expect(readdirSync(join(brainDirs(vault).brain, ".snapshots")).length).toBe(0);
  });
});
