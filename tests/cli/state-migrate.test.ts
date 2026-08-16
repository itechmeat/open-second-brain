/**
 * `o2b state migrate` / `o2b state rollback` - the ladder and the exit
 * contract.
 *
 * The move itself is `tests/core/state/migrate.test.ts`'s subject. What
 * this layer owns is the part an operator meets first and a supervisor
 * reads: that a bare invocation PLANS, that `--apply` needs `--yes` when
 * nobody can answer a prompt, and that a refusal is a distinct exit code
 * from a mistake in the argv. The last one is the reason the refusals are
 * a returned value rather than a warning: `1` says the command answered
 * and the answer was no, `2` says the invocation was wrong, and a
 * supervisor that cannot tell them apart retries the wrong one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MIGRATION_MANIFEST_FILE, type MigrationPlan } from "../../src/core/state/migrate.ts";
import { STATE_SURFACE_ID, STATE_SURFACES } from "../../src/core/state/surfaces.ts";
import { runCli } from "../helpers/run-cli.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function surfacePath(vault: string, id: string): string {
  return STATE_SURFACES.find((s) => s.id === id)!.derive(vault, null);
}

function seedVault(): string {
  const vault = tempDir("osb-state-migrate-cli-");
  for (const [path, body] of [
    [surfacePath(vault, STATE_SURFACE_ID.searchIndex), "index-bytes"],
    [join(surfacePath(vault, STATE_SURFACE_ID.metrics), "recall.jsonl"), "{}\n"],
  ] as ReadonlyArray<readonly [string, string]>) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return vault;
}

describe("o2b state migrate", () => {
  test("plans by default and moves nothing", async () => {
    const vault = seedVault();
    const dest = join(tempDir("osb-state-dest-"), "moved");

    const r = await runCli(["state", "migrate", "--vault", vault, "--to", dest, "--json"]);
    expect(r.returncode).toBe(0);
    const plan = JSON.parse(r.stdout) as MigrationPlan;
    expect(plan.manifest.entries).toHaveLength(2);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(surfacePath(vault, STATE_SURFACE_ID.searchIndex))).toBe(true);
  });

  test("requires --to and says so in the usage stream", async () => {
    const vault = seedVault();
    const r = await runCli(["state", "migrate", "--vault", vault]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--to <dir>");
  });

  test("refuses --dry-run together with --apply", async () => {
    const vault = seedVault();
    const dest = join(tempDir("osb-state-dest-"), "moved");
    const r = await runCli([
      "state",
      "migrate",
      "--vault",
      vault,
      "--to",
      dest,
      "--dry-run",
      "--apply",
    ]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses --apply without --yes when nobody can answer a prompt", async () => {
    const vault = seedVault();
    const dest = join(tempDir("osb-state-dest-"), "moved");
    const r = await runCli([
      "state",
      "migrate",
      "--vault",
      vault,
      "--to",
      dest,
      "--apply",
      "--json",
    ]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(existsSync(dest)).toBe(false);
  });

  test("a refusal is exit 1, names what it found, and moves nothing", async () => {
    const vault = seedVault();
    const dest = join(vault, "inside");

    const r = await runCli(["state", "migrate", "--vault", vault, "--to", dest]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("reserved_namespace");
    expect(r.stderr).toContain("do:");
    expect(existsSync(dest)).toBe(false);
  });

  test("--apply --yes moves the tree and leaves a manifest that rolls it back", async () => {
    const vault = seedVault();
    const dest = join(tempDir("osb-state-dest-"), "moved");

    const applied = await runCli([
      "state",
      "migrate",
      "--vault",
      vault,
      "--to",
      dest,
      "--apply",
      "--yes",
    ]);
    expect(applied.returncode).toBe(0);
    expect(applied.stdout).toContain("moved 2 file(s)");
    expect(existsSync(join(dest, MIGRATION_MANIFEST_FILE))).toBe(true);
    expect(existsSync(surfacePath(vault, STATE_SURFACE_ID.searchIndex))).toBe(false);

    const rolled = await runCli(["state", "rollback", "--from", dest, "--apply", "--yes"]);
    expect(rolled.returncode).toBe(0);
    expect(readFileSync(surfacePath(vault, STATE_SURFACE_ID.searchIndex), "utf8")).toBe(
      "index-bytes",
    );
  });
});

describe("o2b state rollback", () => {
  test("requires --from and says where the manifest lives", async () => {
    const r = await runCli(["state", "rollback"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--from <dir>");
  });

  /**
   * The command an operator runs after they have moved the vault. It used
   * to exit 0 having recreated the dead path, copied into it, deleted the
   * destination copies and removed the manifest - a data loss reported as
   * a success. Now it refuses by name, and `--to` is the way through.
   */
  test("a vault renamed since the migration is refused, and --to puts the files back", async () => {
    const vault = seedVault();
    const dest = join(tempDir("osb-state-dest-"), "moved");
    await runCli(["state", "migrate", "--vault", vault, "--to", dest, "--apply", "--yes"]);
    const renamed = `${vault}-renamed`;
    renameSync(vault, renamed);
    temps.push(renamed);

    const refused = await runCli(["state", "rollback", "--from", dest, "--apply", "--yes"]);
    expect(refused.returncode).toBe(1);
    expect(refused.stderr).toContain(vault);
    expect(refused.stderr).toContain("--to");
    expect(existsSync(join(dest, MIGRATION_MANIFEST_FILE))).toBe(true);

    const rolled = await runCli([
      "state",
      "rollback",
      "--from",
      dest,
      "--to",
      renamed,
      "--apply",
      "--yes",
    ]);
    expect(rolled.returncode).toBe(0);
    expect(readFileSync(surfacePath(renamed, STATE_SURFACE_ID.searchIndex), "utf8")).toBe(
      "index-bytes",
    );
    expect(existsSync(vault)).toBe(false);
  });

  test("a refused entry is named and exits 1 even though the rest restored", async () => {
    const vault = seedVault();
    const dest = join(tempDir("osb-state-dest-"), "moved");
    await runCli(["state", "migrate", "--vault", vault, "--to", dest, "--apply", "--yes"]);

    const edited = join(dest, "Brain/metrics/recall.jsonl");
    writeFileSync(edited, "{}\nedited after the migration\n");

    const r = await runCli(["state", "rollback", "--from", dest, "--apply", "--yes"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("Brain/metrics/recall.jsonl");
    expect(r.stdout).toContain("digest_mismatch");
    // Refused means LEFT ALONE, never deleted.
    expect(readFileSync(edited, "utf8")).toContain("edited after the migration");
  });
});
