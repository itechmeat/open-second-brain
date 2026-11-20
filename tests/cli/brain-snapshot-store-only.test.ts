/**
 * The legacy snapshot verbs on a switched vault whose `Brain/` tree was
 * removed. A snapshot there (taken by a destructive operation) holds only
 * the machine's device-local state, so a restore or a diff against the
 * live tree refuses with the commands that do what the operator is after,
 * instead of comparing against an empty vault `Brain/` and restoring
 * nothing of the memory; the listing still works, and no `Brain/` folder
 * is written into the vault.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteBySource } from "../../src/core/brain/source-cleanup.ts";
import { removeLegacy } from "../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../core/store-migration/fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

test("rollback and a live diff refuse on a switched vault; the listing still works", async () => {
  bench = makeMigrationBench("osb-snapshot-store-only-");
  const { vault } = bench;
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "x.md"), "# X\n");
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "sources", "x.md"),
    "---\nkind: brain-source\nsource_path: notes/x.md\n---\n\nSummary.\n",
  );
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  // A destructive operation on the switched machine takes a snapshot.
  const done = deleteBySource(vault, "notes/x.md", { confirm: true });
  const runId = done.snapshotRunId;
  expect(runId).not.toBeNull();

  const log = await runCli(["brain", "snapshot", "log", "--json"], { env: bench.env });
  expect(log.returncode).toBe(0);
  expect(log.stdout).toContain(runId!);

  for (const argv of [
    ["brain", "rollback", runId!, "--yes"],
    ["brain", "rollback", runId!, "--dry-run"],
    ["brain", "snapshot", "diff", runId!],
  ]) {
    const out = await runCli(argv, { env: bench.env });
    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("o2b brain migrate-store --rollback");
  }
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});

test("a machine that never switched and has no Brain/ is not refused", async () => {
  const parent = mkdtempSync(join(tmpdir(), "osb-snapshot-unswitched-"));
  try {
    const vault = join(parent, "vault");
    mkdirSync(vault, { recursive: true });
    const config = join(parent, "config.yaml");
    writeFileSync(config, `vault: ${vault}\n`);
    const env = {
      OPEN_SECOND_BRAIN_CONFIG: config,
      OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
      O2B_DEVICE_ID: "dev-unswitched",
      HOME: join(parent, "home"),
      XDG_STATE_HOME: join(parent, "state"),
      LOCALAPPDATA: join(parent, "state"),
    };
    for (const argv of [
      ["brain", "rollback", "20261101T000000Z-missing", "--dry-run"],
      ["brain", "snapshot", "diff", "20261101T000000Z-missing"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const out = await runCli(argv, { env });
      // It reaches the archive lookup instead of the switched-machine refusal.
      expect(out.stderr).not.toContain("o2b brain migrate-store --rollback");
    }
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
