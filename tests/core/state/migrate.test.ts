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
 *     otherwise perfectly movable, and each one asserts that NOTHING
 *     moved - not that the call threw. A plan that reported a refusal and
 *     still copied half a tree would pass a throw-shaped assertion.
 *   - PUT BACK ONLY WHAT IS STILL THE SAME. The rollback tests change a
 *     migrated file behind the tool's back and assert it is named,
 *     refused, and STILL THERE afterwards. Deleting a file the operator
 *     edited after the migration is the failure this half exists to
 *     prevent, and it is invisible to a test that only checks the exit
 *     code.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
    expect(refusal.remedy.length).toBeGreaterThan(20);
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
    expect(existsSync(dest)).toBe(false);
  });

  test("insufficient free space at the destination", () => {
    const vault = seedVault();
    const dest = join(tempDir(), "moved");

    const p = plan(vault, dest, { freeBytesAt: () => 1 });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.insufficientSpace);
    expect(refusal?.found).toContain("1 byte");
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
    expect(() => applyStateMigration(p)).toThrow(StateMigrationError);
    expect(existsSync(dest)).toBe(false);
  });

  test("a lock whose state could not be determined is refused, not assumed free", () => {
    const vault = seedVault();
    const p = plan(vault, join(tempDir(), "moved"), {
      writerLockHeldAt: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.writerLockHeld);
    expect(refusal?.found).toContain("EACCES");
  });

  test("a surface that could not be probed, rather than silently leaving it behind", () => {
    const vault = seedVault();
    const p = plan(vault, join(tempDir(), "moved"), {
      statAt: (path: string) => {
        if (path.endsWith("metrics")) throw Object.assign(new Error("nope"), { code: "EACCES" });
        return undefined;
      },
    });
    const refusal = p.refusals.find((r) => r.code === MIGRATION_REFUSAL.unreadableSurface);
    expect(refusal?.path).toBe(surfacePath(vault, STATE_SURFACE_ID.metrics));
    expect(refusal?.found).toContain("EACCES");
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
  });

  test("refuses to clobber a source path that diverged since the migration", () => {
    const { vault, dest } = migrated();
    write(join(vault, "Brain/metrics/recall.jsonl"), "written again since\n");

    const p = planStateRollback({ destination: dest });
    const refusal = p.refusals.find((r) => r.code === ROLLBACK_REFUSAL.sourceDiverged);
    expect(refusal?.relative_path).toBe("Brain/metrics/recall.jsonl");

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

  test("refuses a manifest whose own digest does not verify", () => {
    const { dest } = migrated();
    const manifestPath = join(dest, MIGRATION_MANIFEST_FILE);
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    doc.entries[0].bytes = 0;
    writeFileSync(manifestPath, JSON.stringify(doc));

    expect(() => planStateRollback({ destination: dest })).toThrow(StateMigrationError);
  });
});
