/**
 * Moving a vault's state, and putting it back.
 *
 * The unit under test is the one operation in this project where a
 * half-completed run is worse than no run at all: bytes that exist in
 * neither the old place nor the new one are gone, and the surfaces the
 * inventory calls `vault-content` do not rebuild. So the tests below are
 * organised around the two guarantees that follow from that, rather than
 * around the functions:
 *
 *   - FAIL BEFORE COMMIT. Every refusal is driven with the source tree
 *     otherwise perfectly movable, and each one drives `applyStateMigration`
 *     and asserts that NOTHING moved - not that the call threw. A plan
 *     that reported a refusal and still copied half a tree would pass a
 *     throw-shaped assertion. Three of the seven used to stop at the
 *     plan: `reserved_namespace`, the unreadable-lock case and
 *     `unreadable_surface` never called apply at all, so their
 *     `expect(existsSync(dest)).toBe(false)` was true of a destination
 *     nothing had ever been asked to write.
 *   - PUT BACK ONLY WHAT IS STILL THE SAME. The rollback tests change a
 *     migrated file behind the tool's back and assert it is named,
 *     refused, and STILL THERE afterwards. Deleting a file the operator
 *     edited after the migration is the failure this half exists to
 *     prevent, and it is invisible to a test that only checks the exit
 *     code.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalJson, sha256Hex } from "../../../src/core/integrity/digest.ts";
import {
  applyStateMigration,
  applyStateRollback,
  MIGRATION_MANIFEST_FILE,
  MIGRATION_REFUSAL,
  MIGRATION_SOURCE_TYPE,
  planStateMigration,
  planStateRollback,
  renderRollbackPlan,
  ROLLBACK_REFUSAL,
  StateMigrationError,
  type MigrationPlan,
} from "../../../src/core/state/migrate.ts";
import { STATE_SURFACE_ID, STATE_SURFACES } from "../../../src/core/state/surfaces.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-state-migrate-"));
  temps.push(dir);
  return dir;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** The resolved location of one declared surface in `vault`, no overrides. */
function surfacePath(vault: string, id: string): string {
  const surface = STATE_SURFACES.find((s) => s.id === id);
  if (surface === undefined) throw new Error(`no such surface: ${id}`);
  return surface.derive(vault, null);
}

/**
 * A vault with real bytes under both roots, including one surface nested
 * inside another so the canonical-root collapse is exercised by default
 * rather than by a test that has to remember to arrange it.
 */
function seedVault(): string {
  const vault = tempDir();
  write(surfacePath(vault, STATE_SURFACE_ID.searchIndex), "index-bytes");
  write(surfacePath(vault, STATE_SURFACE_ID.ingestContentManifest), "{}\n");
  write(join(surfacePath(vault, STATE_SURFACE_ID.brainLog), "2026-08-16.md"), "# today\n");
  write(join(surfacePath(vault, STATE_SURFACE_ID.dreamRuns), "run-1.jsonl"), "{}\n");
  write(join(surfacePath(vault, STATE_SURFACE_ID.metrics), "recall.jsonl"), "{}\n");
  return vault;
}

function plan(
  vault: string,
  destination: string,
  extra: Record<string, unknown> = {},
): MigrationPlan {
  return planStateMigration({
    vault,
    destination,
    env: {},
    config: {},
    now: new Date("2026-08-16T10:00:00.000Z"),
    ...extra,
  });
}

/** Every file under `root`, as vault-relative paths. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.toSorted();
}

function refusalCodes(p: MigrationPlan): string[] {
  return p.refusals.map((r) => r.code).toSorted();
}

/**
 * The bar a remedy has to clear.
 *
 * It was `remedy.length > 20`, applied to one of the seven refusal codes,
 * and `"TODO: fix this later!!"` is twenty-two characters. A remedy is
 * the sentence that turns a refusal into something the operator can act
 * on; the shortest real one in this module - "name an empty directory, or
 * a path that does not exist yet" - is fifty-seven.
 */
const MIN_REMEDY_LENGTH = 50;

/** Words that mean nobody has decided yet, which is not a remedy. */
const LAZY_REMEDY_RE = /\bTODO\b|\bfor now\b|\blater\b/i;

/** Every refusal in `refusals` says what to DO, named when one does not. */
function expectActionableRemedies(
  refusals: ReadonlyArray<{ readonly code: string; readonly remedy: string }>,
): void {
  // Folded into one expectation whose value NAMES the offender: asserting
  // per refusal would stop at the first and hide the rest.
  const thin = refusals
    .filter((r) => r.remedy.trim().length < MIN_REMEDY_LENGTH || LAZY_REMEDY_RE.test(r.remedy))
    .map((r) => `${r.code}: ${r.remedy.trim()}`);
  expect(thin.toSorted().join("\n")).toBe("");
}

describe("state migration plan", () => {
  test("inventories every file under both roots with its byte count and digest", () => {
    const vault = seedVault();
    const p = plan(vault, join(tempDir(), "moved"));

    expect(p.refusals).toEqual([]);
    expect(p.manifest.source_type).toBe(MIGRATION_SOURCE_TYPE.vault);
    expect(p.manifest.entries.map((e) => e.relative_path)).toEqual([
      ".open-second-brain/brain.sqlite",
      ".open-second-brain/ingest-manifest.json",
      "Brain/log/2026-08-16.md",
      "Brain/log/dream-runs/run-1.jsonl",
      "Brain/metrics/recall.jsonl",
    ]);
    const index = p.manifest.entries.find(
      (e) => e.relative_path === ".open-second-brain/brain.sqlite",
    );
    expect(index?.bytes).toBe("index-bytes".length);
    expect(index?.digest).toBe(sha256Hex("index-bytes"));
    expect(p.manifest.total_bytes).toBe(p.manifest.entries.reduce((sum, e) => sum + e.bytes, 0));
  });

  test("collapses a nested surface into the canonical root that contains it", () => {
    const vault = seedVault();
    const p = plan(vault, join(tempDir(), "moved"));
    // A root is a DECLARED surface, never its parent directory: the two
    // files under the derived store are two surfaces and stay two roots,
    // so nothing undeclared beside them is swept along. `Brain/log/dream-
    // runs` IS declared and IS under `Brain/log`, so it is absorbed;
    // without the collapse its files would be bound twice.
    expect(p.manifest.canonical_roots).toEqual([
      ".open-second-brain/brain.sqlite",
      ".open-second-brain/ingest-manifest.json",
      "Brain/log",
      "Brain/metrics",
    ]);
  });

  test("binds the manifest through canonicalJson so a byte edit invalidates it", () => {
    const vault = seedVault();
    const p = plan(vault, join(tempDir(), "moved"));
    const { digest, ...bound } = p.manifest;
    expect(digest).toBe(sha256Hex(canonicalJson(bound)));
  });
});

describe("state migration refuses before it commits", () => {
  test("a symlink in the source tree, by name", () => {
    const vault = seedVault();
    const link = join(surfacePath(vault, STATE_SURFACE_ID.metrics), "elsewhere.jsonl");
    symlinkSync("/etc/hostname", link);
    const dest = join(tempDir(), "moved");

    const p = plan(vault, dest);
    expect(refusalCodes(p)).toContain(MIGRATION_REFUSAL.symlink);
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.symlink)!;
    expect(refusal.path).toBe(link);
    expect(refusal.found).toContain("/etc/hostname");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a special file in the source tree, by name", () => {
    const vault = seedVault();
    const fifo = join(surfacePath(vault, STATE_SURFACE_ID.metrics), "pipe");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const dest = join(tempDir(), "moved");

    const p = plan(vault, dest);
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.specialFile);
    expect(refusal?.path).toBe(fifo);
    expect(refusal?.found).toContain("FIFO");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a destination that already holds content", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    write(join(dest, "notes", "keep.md"), "mine\n");

    const p = plan(vault, dest);
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.destinationOccupied);
    expect(refusal?.path).toBe(dest);
    expect(refusal?.found).toContain("notes");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(tree(dest)).toEqual(["notes/keep.md"]);
  });

  test("a destination inside the source vault, as a reserved namespace", () => {
    const vault = seedVault();
    const dest = join(vault, "inside");

    const p = plan(vault, dest);
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.reservedNamespace);
    expect(refusal?.path).toBe(dest);
    expect(refusal?.found).toContain(vault);
    expectActionableRemedies(p.refusals);
    // The apply is the assertion. Without it `existsSync(dest)` was true
    // of a path nothing had been asked to create, which is a fact about
    // this test rather than about the module.
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
    for (const entry of p.manifest.entries) {
      expect(existsSync(join(vault, entry.relative_path))).toBe(true);
    }
  });

  test("insufficient free space at the destination", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");

    const p = plan(vault, dest, { freeBytesAt: () => 1 });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.insufficientSpace);
    expect(refusal?.found).toContain("1 byte");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a held search writer lock, which is the one loss a digest cannot undo", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");

    const p = plan(vault, dest, { writerLockHeldAt: () => true });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.writerLockHeld);
    expect(refusal?.path).toBe(surfacePath(vault, STATE_SURFACE_ID.searchIndex));
    expect(refusal?.remedy).toContain("reindex");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a lock whose state could not be determined is refused, not assumed free", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    const p = plan(vault, dest, {
      writerLockHeldAt: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.writerLockHeld);
    expect(refusal?.found).toContain("EACCES");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a surface that could not be probed, rather than silently leaving it behind", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    const p = plan(vault, dest, {
      statAt: (path: string) => {
        if (path.endsWith("metrics")) throw Object.assign(new Error("nope"), { code: "EACCES" });
        return undefined;
      },
    });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.unreadableSurface);
    expect(refusal?.path).toBe(surfacePath(vault, STATE_SURFACE_ID.metrics));
    expect(refusal?.found).toContain("EACCES");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
    // Named rather than looped over `p.manifest.entries`: the stub
    // reports every OTHER surface absent, so that list is empty here and
    // a loop over it would assert nothing at all.
    expect(existsSync(join(surfacePath(vault, STATE_SURFACE_ID.metrics), "recall.jsonl"))).toBe(
      true,
    );
    expect(existsSync(surfacePath(vault, STATE_SURFACE_ID.searchIndex))).toBe(true);
  });

  test("a destination that reaches the vault through a symlink, which resolve() cannot see", () => {
    // `resolve` is a string operation: it collapses `..` and knows
    // nothing about links, so a destination whose parent is a link INTO
    // the vault passed every prefix test while landing the whole state
    // tree inside the vault being migrated.
    const vault = seedVault();
    const link = join(tempDir(), "link");
    symlinkSync(join(vault, "Brain"), link);
    const dest = join(link, "state");

    const p = plan(vault, dest);
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.reservedNamespace);
    expect(refusal?.path).toBe(dest);
    expect(refusal?.found).toContain(vault);
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a directory in the state tree that cannot be listed, as a refusal not a stack", () => {
    const vault = seedVault();
    const locked = surfacePath(vault, STATE_SURFACE_ID.metrics);
    chmodSync(locked, 0o000);
    try {
      const p = plan(vault, join(tempDir(), "moved"), { writerLockHeldAt: () => true });
      const refusal = p.refusals.find(
        (r) => r.code === MIGRATION_REFUSAL.unreadableSurface && r.path === locked,
      );
      expect(refusal?.found).toContain("EACCES");
      // The headline contract: an unreadable directory is one refusal
      // among all of them, not a throw that leaves the rest uncomputed.
      expectActionableRemedies(p.refusals);
      expect(refusalCodes(p)).toContain(MIGRATION_REFUSAL.writerLockHeld);
      expect(p.manifest.entries.map((e) => e.relative_path)).toContain(
        ".open-second-brain/brain.sqlite",
      );
      expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a surface root that is a DANGLING symlink reaches the symlink refusal", () => {
    // `statSync` follows the link and reports the missing target as
    // ENOENT, so the surface read as `absent` and the migration skipped
    // it in silence - the one outcome a refusal-shaped module must not
    // have. Deeper in the tree the same link is caught by name.
    const vault = seedVault();
    const metrics = surfacePath(vault, STATE_SURFACE_ID.metrics);
    rmSync(metrics, { recursive: true, force: true });
    symlinkSync(join(vault, "nowhere"), metrics);

    const p = plan(vault, join(tempDir(), "moved"));
    const refusal = p.refusals.find(
      (r) => r.code === MIGRATION_REFUSAL.symlink && r.path === metrics,
    );
    expect(refusal?.found).toContain("nowhere");
    expectActionableRemedies(p.refusals);
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
  });

  test("every refusal is collected, so one run tells the operator all of it", () => {
    const vault = seedVault();
    symlinkSync("/etc/hostname", join(surfacePath(vault, STATE_SURFACE_ID.metrics), "link"));
    const dest = join(vault, "inside");
    write(join(dest, "already.md"), "here first\n");

    const p = plan(vault, dest, { freeBytesAt: () => 0, writerLockHeldAt: () => true });
    expect(refusalCodes(p)).toEqual(
      [
        MIGRATION_REFUSAL.destinationOccupied,
        MIGRATION_REFUSAL.insufficientSpace,
        MIGRATION_REFUSAL.reservedNamespace,
        MIGRATION_REFUSAL.symlink,
        MIGRATION_REFUSAL.writerLockHeld,
      ].toSorted(),
    );
  });
});

describe("state migration apply", () => {
  test("lands every bound file, writes the manifest, and empties the source", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");

    const p = plan(vault, dest);
    const result = applyStateMigration(p);

    expect(result.manifest_path).toBe(join(dest, MIGRATION_MANIFEST_FILE));
    expect(tree(dest).filter((f) => f !== MIGRATION_MANIFEST_FILE)).toEqual(
      p.manifest.entries.map((e) => e.relative_path),
    );
    expect(readFileSync(join(dest, ".open-second-brain/brain.sqlite"), "utf8")).toBe("index-bytes");
    for (const entry of p.manifest.entries) {
      expect(existsSync(join(vault, entry.relative_path))).toBe(false);
    }
    expect(result.moved).toEqual(p.manifest.entries.map((e) => e.relative_path));
  });

  test("a manifest written by apply is the plan's manifest, digest and all", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    const p = plan(vault, dest);
    applyStateMigration(p);

    const onDisk = JSON.parse(readFileSync(join(dest, MIGRATION_MANIFEST_FILE), "utf8"));
    expect(onDisk.digest).toBe(p.manifest.digest);
    const { digest, ...bound } = onDisk;
    expect(digest).toBe(sha256Hex(canonicalJson(bound)));
  });

  /**
   * The module's stated core guarantee, driven by a REAL mid-copy failure
   * rather than a mocked one: the bytes of the third bound file change
   * after the plan measured them, so its copy lands, fails the digest
   * check, and aborts the pass with two files already at the destination.
   */
  test("a copy that fails half way unwinds the destination and leaves the source as it was", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    const p = plan(vault, dest);
    const before = p.manifest.entries.map((e) =>
      readFileSync(join(vault, e.relative_path), "utf8"),
    );
    writeFileSync(join(vault, "Brain/log/2026-08-16.md"), "# today, rewritten after the plan\n");

    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);

    // Nothing of ours is left at the destination, not even the directory
    // skeleton `mkdirSync` created on the way down: the identical command
    // is retried, not refused with `destination_occupied`.
    expect(existsSync(dest)).toBe(false);
    expect(plan(vault, dest).refusals).toEqual([]);
    // And the source is exactly as the run found it - the one file this
    // test rewrote aside, which is the failure it drove.
    p.manifest.entries.forEach((entry, at) => {
      expect(existsSync(join(vault, entry.relative_path))).toBe(true);
      if (entry.relative_path === "Brain/log/2026-08-16.md") return;
      expect(readFileSync(join(vault, entry.relative_path), "utf8")).toBe(before[at]!);
    });
  });

  test("a file that appeared at the destination after the plan is never overwritten", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    const p = plan(vault, dest);
    // `destination_occupied` was measured before the operator read the
    // plan. What arrives afterwards used to be copied over AND then
    // deleted by the unwind, which cannot tell a file it created from one
    // it clobbered.
    const theirs = join(dest, "Brain/metrics/recall.jsonl");
    write(theirs, "SOMEONE-ELSES-FILE\n");

    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(readFileSync(theirs, "utf8")).toBe("SOMEONE-ELSES-FILE\n");
    expect(tree(dest)).toEqual(["Brain/metrics/recall.jsonl"]);
    for (const entry of p.manifest.entries) {
      expect(existsSync(join(vault, entry.relative_path))).toBe(true);
    }
  });

  test("a source it cannot remove says the bytes are safe and names the manifest", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    const p = plan(vault, dest);
    // Readable and traversable, but not writable: every file lands and
    // verifies, and the unlink pass is the thing that fails.
    const metrics = surfacePath(vault, STATE_SURFACE_ID.metrics);
    chmodSync(metrics, 0o500);
    try {
      let caught: unknown;
      try {
        applyStateMigration(p);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StateMigrationError);
      expect((caught as Error).message).toContain(join(dest, MIGRATION_MANIFEST_FILE));
      expect((caught as Error).message).toContain("rollback");
      expect(readFileSync(join(dest, "Brain/metrics/recall.jsonl"), "utf8")).toBe("{}\n");
    } finally {
      chmodSync(metrics, 0o755);
    }
  });
});

describe("state rollback", () => {
  function migrated(): { vault: string; dest: string } {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    applyStateMigration(plan(vault, dest));
    return { vault, dest };
  }

  test("restores every entry whose digest still matches", () => {
    const { vault, dest } = migrated();

    const p = planStateRollback({ destination: dest });
    expect(p.refusals).toEqual([]);
    const result = applyStateRollback(p);

    expect(result.restored).toEqual(p.restore.map((e) => e.relative_path));
    expect(readFileSync(join(vault, ".open-second-brain/brain.sqlite"), "utf8")).toBe(
      "index-bytes",
    );
    expect(existsSync(join(dest, ".open-second-brain/brain.sqlite"))).toBe(false);
    expect(existsSync(join(dest, MIGRATION_MANIFEST_FILE))).toBe(false);
  });

  test("refuses a file changed after the migration BY NAME and leaves it alone", () => {
    const { vault, dest } = migrated();
    const edited = join(dest, "Brain/log/2026-08-16.md");
    writeFileSync(edited, "# today\nplus a line the operator added\n");

    const p = planStateRollback({ destination: dest });
    const refusal = p.refusals.find((r) => r.code === ROLLBACK_REFUSAL.digestMismatch);
    expect(refusal?.relative_path).toBe("Brain/log/2026-08-16.md");
    expect(refusal?.remedy).toContain("copy");
    expectActionableRemedies(p.refusals);

    const result = applyStateRollback(p);
    expect(result.refused.map((r) => r.relative_path)).toEqual(["Brain/log/2026-08-16.md"]);
    expect(readFileSync(edited, "utf8")).toContain("the operator added");
    expect(existsSync(join(vault, "Brain/log/2026-08-16.md"))).toBe(false);
    // The manifest survives an incomplete rollback: the refused entry is
    // still bound by it, and deleting it would strand the only record of
    // where that file came from.
    expect(existsSync(join(dest, MIGRATION_MANIFEST_FILE))).toBe(true);
  });

  test("refuses an entry missing from the destination rather than inventing one", () => {
    const { dest } = migrated();
    rmSync(join(dest, "Brain/metrics/recall.jsonl"));

    const p = planStateRollback({ destination: dest });
    const refusal = p.refusals.find((r) => r.code === ROLLBACK_REFUSAL.missingAtDestination);
    expect(refusal?.relative_path).toBe("Brain/metrics/recall.jsonl");
    expectActionableRemedies(p.refusals);
  });

  test("refuses to clobber a source path that diverged since the migration", () => {
    const { vault, dest } = migrated();
    write(join(vault, "Brain/metrics/recall.jsonl"), "written again since\n");

    const p = planStateRollback({ destination: dest });
    const refusal = p.refusals.find((r) => r.code === ROLLBACK_REFUSAL.sourceDiverged);
    expect(refusal?.relative_path).toBe("Brain/metrics/recall.jsonl");
    expectActionableRemedies(p.refusals);

    applyStateRollback(p);
    expect(readFileSync(join(vault, "Brain/metrics/recall.jsonl"), "utf8")).toBe(
      "written again since\n",
    );
    expect(existsSync(join(dest, "Brain/metrics/recall.jsonl"))).toBe(true);
  });

  test("a source path already back in place with the same bytes counts as restored", () => {
    const { vault, dest } = migrated();
    // The shape a crash between the copy and the removal leaves behind.
    write(join(vault, "Brain/metrics/recall.jsonl"), "{}\n");

    const p = planStateRollback({ destination: dest });
    expect(p.refusals).toEqual([]);
    const result = applyStateRollback(p);
    expect(result.restored).toContain("Brain/metrics/recall.jsonl");
  });

  test("a source path that appeared between the plan and the apply is never overwritten", () => {
    const { vault, dest } = migrated();
    const p = planStateRollback({ destination: dest });
    expect(p.refusals).toEqual([]);
    // The plan cleared this entry against an empty source path. The
    // operator wrote there while reading it, and the apply used to copy
    // straight over them.
    const target = join(vault, "Brain/metrics/recall.jsonl");
    write(target, "OPERATOR-WROTE-THIS-AFTER-PLANNING\n");

    const result = applyStateRollback(p);
    expect(readFileSync(target, "utf8")).toBe("OPERATOR-WROTE-THIS-AFTER-PLANNING\n");
    expect(result.restored).not.toContain("Brain/metrics/recall.jsonl");
    expect(result.refused.map((r) => r.code)).toContain(ROLLBACK_REFUSAL.sourceDiverged);
    expect(existsSync(join(dest, "Brain/metrics/recall.jsonl"))).toBe(true);
    expect(result.manifest_removed).toBe(false);
    expect(existsSync(join(dest, MIGRATION_MANIFEST_FILE))).toBe(true);
  });

  test("one entry it cannot read is refused by name and the rest still go back", () => {
    const { vault, dest } = migrated();
    // The source path recreated as a DIRECTORY: reading it for a digest
    // fails with EISDIR, which used to abort the whole plan and take
    // every other restorable entry with it.
    mkdirSync(join(vault, "Brain/metrics/recall.jsonl"), { recursive: true });

    const p = planStateRollback({ destination: dest });
    const refusal = p.refusals.find((r) => r.code === ROLLBACK_REFUSAL.unreadable);
    expect(refusal?.relative_path).toBe("Brain/metrics/recall.jsonl");
    expect(refusal?.found).toContain("EISDIR");
    expectActionableRemedies(p.refusals);
    expect(p.restore.map((e) => e.relative_path)).toContain("Brain/log/2026-08-16.md");

    const result = applyStateRollback(p);
    expect(result.restored).toContain("Brain/log/2026-08-16.md");
    expect(existsSync(join(dest, "Brain/metrics/recall.jsonl"))).toBe(true);
    expect(result.manifest_removed).toBe(false);
  });

  test("a directory the prune cannot look inside is left alone, not judged empty", () => {
    const { dest } = migrated();
    // Listable, but its children cannot be stat'ed. Reading that as
    // "empty" made the `rmdir` below throw ENOTEMPTY out of a rollback
    // that had in fact succeeded.
    const opaque = join(dest, "Brain/metrics/extra");
    write(join(opaque, "keep.jsonl"), "not ours\n");
    chmodSync(opaque, 0o444);
    try {
      const result = applyStateRollback(planStateRollback({ destination: dest }));
      expect(result.restored).toContain("Brain/metrics/recall.jsonl");
      expect(existsSync(opaque)).toBe(true);
    } finally {
      chmodSync(opaque, 0o755);
    }
  });

  test("refuses a source root that is no longer there rather than recreating it", () => {
    const { vault, dest } = migrated();
    const renamed = `${vault}-renamed`;
    renameSync(vault, renamed);
    temps.push(renamed);

    let caught: unknown;
    try {
      planStateRollback({ destination: dest });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateMigrationError);
    expect((caught as Error).message).toContain(vault);
    expect((caught as Error).message).toContain("--to");
    // The dead path stays dead, and the only copies stay where they are.
    expect(existsSync(vault)).toBe(false);
    expect(existsSync(join(dest, ".open-second-brain/brain.sqlite"))).toBe(true);
    expect(existsSync(join(dest, MIGRATION_MANIFEST_FILE))).toBe(true);
  });

  test("--to restores into the vault's new location and still reports the recorded root", () => {
    const { vault, dest } = migrated();
    const renamed = `${vault}-renamed`;
    renameSync(vault, renamed);
    temps.push(renamed);

    const p = planStateRollback({ destination: dest, vault: renamed });
    expect(p.source).toBe(renamed);
    expect(p.manifest.source_root).toBe(vault);
    expect(renderRollbackPlan(p)).toContain(vault);

    const result = applyStateRollback(p);
    expect(result.restored).toContain(".open-second-brain/brain.sqlite");
    expect(readFileSync(join(renamed, ".open-second-brain/brain.sqlite"), "utf8")).toBe(
      "index-bytes",
    );
    expect(existsSync(vault)).toBe(false);
  });

  test("refuses a manifest whose own digest does not verify", () => {
    const { dest } = migrated();
    const manifestPath = join(dest, MIGRATION_MANIFEST_FILE);
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    doc.entries[0].bytes = 0;
    writeFileSync(manifestPath, JSON.stringify(doc));

    expect(() => planStateRollback({ destination: dest })).toThrow(StateMigrationError);
  });
});

/**
 * Every declared refusal code is REACHED by something here.
 *
 * A code nobody drives is a branch nobody has read: `ROLLBACK_REFUSAL.
 * unreadable` was declared and produced nowhere for a release, and the
 * suite was as green then as it is now. This block builds the conditions
 * itself rather than accumulating codes seen by the tests above, so it
 * says the same thing when one test is run in isolation as it does when
 * the file is run whole.
 */
describe("every declared refusal code is reachable", () => {
  test("the migration codes, all seven, with a remedy each", () => {
    // Six from one plan, because they are independent conditions and a
    // plan collects all of them; the seventh needs a probe that throws,
    // which would hide the surfaces the other six are read from.
    const vault = seedVault();
    const metrics = surfacePath(vault, STATE_SURFACE_ID.metrics);
    symlinkSync("/etc/hostname", join(metrics, "link"));
    expect(Bun.spawnSync(["mkfifo", join(metrics, "pipe")]).exitCode).toBe(0);
    const occupied = join(vault, "inside");
    write(join(occupied, "already.md"), "here first\n");

    const many = plan(vault, occupied, { freeBytesAt: () => 0, writerLockHeldAt: () => true });
    const unreadable = plan(vault, join(tempDir(), "moved"), {
      statAt: (path: string) => {
        if (path.endsWith("metrics")) throw Object.assign(new Error("nope"), { code: "EACCES" });
        return undefined;
      },
    });

    const seen = new Set([...refusalCodes(many), ...refusalCodes(unreadable)]);
    const unreached = Object.values(MIGRATION_REFUSAL).filter((code) => !seen.has(code));
    expect(unreached.toSorted().join("\n")).toBe("");
    expectActionableRemedies([...many.refusals, ...unreadable.refusals]);
  });

  test("the rollback codes, all four, with a remedy each", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");
    applyStateMigration(plan(vault, dest));

    // One condition per bound entry, so no two of them compete for the
    // same file and the plan has to report all four.
    writeFileSync(join(dest, ".open-second-brain/brain.sqlite"), "edited at the destination");
    rmSync(join(dest, ".open-second-brain/ingest-manifest.json"));
    write(join(vault, "Brain/log/2026-08-16.md"), "# written again since\n");
    mkdirSync(join(vault, "Brain/log/dream-runs/run-1.jsonl"), { recursive: true });

    const p = planStateRollback({ destination: dest });
    const seen = new Set(p.refusals.map((r) => r.code));
    const unreached = Object.values(ROLLBACK_REFUSAL).filter((code) => !seen.has(code));
    expect(unreached.toSorted().join("\n")).toBe("");
    expectActionableRemedies(p.refusals);
  });
});
