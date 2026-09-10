/**
 * `o2b brain freeze` / `o2b brain unfreeze` (who-wrote-what, Task C).
 *
 * The operator surface of the fleet freeze. Freezing is not a status
 * flag: between the two commands every content write in the vault is
 * refused, on this device and on every device that syncs it - so these
 * tests drive a real write in between and hold the refusal to naming the
 * way out.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSnapshot } from "../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let marker: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-freeze-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  // A Brain tree with something in it: the snapshot archiver refuses an
  // empty one, and an operator's vault is never empty either.
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  marker = join(vault, "Brain", ".state", "frozen.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("freeze writes the marker, unfreeze removes it, and both are idempotent", async () => {
  const first = await runCli(["brain", "freeze", "--vault", vault, "--reason", "migrating"]);
  expect(first.returncode).toBe(0);
  expect(first.stdout).toContain("frozen");
  expect(first.stdout).toContain("migrating");
  expect(existsSync(marker)).toBe(true);

  const again = await runCli(["brain", "freeze", "--vault", vault, "--reason", "second"]);
  expect(again.returncode).toBe(0);
  expect(again.stdout).toContain("already frozen");

  const lifted = await runCli(["brain", "unfreeze", "--vault", vault]);
  expect(lifted.returncode).toBe(0);
  expect(existsSync(marker)).toBe(false);

  const noop = await runCli(["brain", "unfreeze", "--vault", vault]);
  expect(noop.returncode).toBe(0);
  expect(noop.stdout).toContain("not frozen");
});

test("--json reports the transition and the marker fields", async () => {
  const frozen = await runCli(["brain", "freeze", "--vault", vault, "--reason", "x", "--json"]);
  expect(frozen.returncode).toBe(0);
  const payload = JSON.parse(frozen.stdout) as Record<string, unknown>;
  expect(payload["ok"]).toBe(true);
  expect(payload["changed"]).toBe(true);
  expect(payload["reason"]).toBe("x");
  expect(typeof payload["frozen_at"]).toBe("string");

  const lifted = await runCli(["brain", "unfreeze", "--vault", vault, "--json"]);
  const liftedPayload = JSON.parse(lifted.stdout) as Record<string, unknown>;
  expect(liftedPayload["changed"]).toBe(true);
  expect(liftedPayload["reason"]).toBe("x");
});

test("a content write is refused while frozen, naming the way out", async () => {
  await runCli(["brain", "freeze", "--vault", vault, "--reason", "migrating"]);
  const set = await runCli([
    "brain",
    "state",
    "set",
    "--vault",
    vault,
    "--aspect",
    "branch",
    "--value",
    "feat/x",
  ]);
  expect(set.returncode).not.toBe(0);
  const said = `${set.stdout}${set.stderr}`;
  expect(said).toContain("frozen");
  expect(said).toContain("o2b brain unfreeze");
});

test("rollback is refused by name while frozen, with no exemption for recovery", async () => {
  // A real recovery point, so the refusal below is the freeze rather
  // than a missing run id. An operator recovering a frozen vault is
  // exactly the operator who should decide the freeze is over, so there
  // is no exemption for the restore path - and no code implementing one:
  // `restoreSnapshot` passes the same guard every other writer does.
  const runId = "dream-2026-09-10-080000";
  createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.dream });
  await runCli(["brain", "freeze", "--vault", vault, "--reason", "migrating"]);

  // `--force-rollback` clears the drift confirmation the freeze itself
  // caused (the marker and the log lines are new since the archive), so
  // the only thing left to refuse the restore is the freeze.
  const back = await runCli([
    "brain",
    "rollback",
    runId,
    "--vault",
    vault,
    "--yes",
    "--force-rollback",
  ]);
  expect(back.returncode).not.toBe(0);
  expect(`${back.stdout}${back.stderr}`).toContain("o2b brain unfreeze");
});

test("status reports the freeze, and stops reporting it once lifted", async () => {
  await runCli(["brain", "freeze", "--vault", vault, "--reason", "migrating"]);
  const frozen = await runCli(["brain", "status", "--vault", vault, "--json"]);
  expect(frozen.returncode).toBe(0);
  const snapshot = JSON.parse(frozen.stdout) as { frozen: Record<string, unknown> | null };
  expect(snapshot.frozen).not.toBeNull();
  expect(snapshot.frozen!["reason"]).toBe("migrating");

  await runCli(["brain", "unfreeze", "--vault", vault]);
  const thawed = await runCli(["brain", "status", "--vault", vault, "--json"]);
  expect((JSON.parse(thawed.stdout) as { frozen: unknown }).frozen).toBeNull();
});

test("the text status prints a frozen line either way", async () => {
  const clear = await runCli(["brain", "status", "--vault", vault]);
  expect(clear.stdout).toContain("frozen: no");

  await runCli(["brain", "freeze", "--vault", vault, "--reason", "migrating"]);
  const frozen = await runCli(["brain", "status", "--vault", vault]);
  expect(frozen.stdout).toContain("frozen: yes");
  expect(frozen.stdout).toContain("migrating");
});
