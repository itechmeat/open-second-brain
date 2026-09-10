/**
 * `o2b brain log verify` (who-wrote-what, Task E).
 *
 * The operator surface of the per-shard hash chain. The verb reports and
 * never repairs, so what these tests hold it to is that it says which
 * shard, which line, and what the break means - and that it exits
 * non-zero when the log does not verify, because a check whose failure
 * looks like its success is not a check.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { logJsonlPath, logShardJsonlPath } from "../../src/core/brain/paths.ts";
import { runCli } from "../helpers/run-cli.ts";

const DATE = "2026-06-03";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-log-verify-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function appendMany(count: number, shardId = ""): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      vault,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${i}`, agent: "@tester" },
      },
      { deviceId: shardId },
    );
  }
}

function dropLine(path: string, line: number): void {
  const rows = readFileSync(path, "utf8").trim().split("\n");
  rows.splice(line - 1, 1);
  writeFileSync(path, rows.join("\n") + "\n", "utf8");
}

test("an intact log verifies clean and exits zero", async () => {
  appendMany(3);
  const res = await runCli(["brain", "log", "verify", "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("1 shard");
  expect(res.stdout).toContain("3 chained");
});

test("a vault with no log at all is reported as such, not as clean silence", async () => {
  const res = await runCli(["brain", "log", "verify", "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("no chained log shard");
});

test("a broken shard is named with its line and the verb exits non-zero", async () => {
  appendMany(3);
  dropLine(logJsonlPath(vault, DATE), 2);

  const res = await runCli(["brain", "log", "verify", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stdout).toContain(logJsonlPath(vault, DATE));
  expect(res.stdout).toContain("line 2");
  expect(res.stdout).toContain("prev-mismatch");
});

test("--json carries every shard, broken or not", async () => {
  appendMany(3, "devalpha");
  appendMany(2, "devbeta");
  dropLine(logShardJsonlPath(vault, DATE, "devalpha"), 2);

  const res = await runCli(["brain", "log", "verify", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(1);
  const payload = JSON.parse(res.stdout) as {
    ok: boolean;
    shards: Array<Record<string, unknown>>;
    notices: Array<Record<string, unknown>>;
  };
  expect(payload.ok).toBe(false);
  expect(payload.shards).toHaveLength(2);
  const alpha = payload.shards.find((s) => s["shard_id"] === "devalpha")!;
  expect(alpha["first_break"]).toEqual({ line: 2, reason: "prev-mismatch" });
  const beta = payload.shards.find((s) => s["shard_id"] === "devbeta")!;
  expect(beta["first_break"]).toBeNull();
  expect(beta["chained"]).toBe(2);
  expect(payload.notices).toHaveLength(1);
});

test("the verb name is reserved: an unknown subcommand is refused by name", async () => {
  const res = await runCli(["brain", "log", "compact", "--vault", vault]);
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("compact");
  expect(res.stderr).toContain("verify");
});

test("no subcommand prints the usage rather than guessing one", async () => {
  const res = await runCli(["brain", "log"]);
  expect(res.returncode).toBe(2);
  const text = res.stdout + res.stderr;
  expect(text).toContain("usage: o2b brain log <verb>");
  expect(text).toContain("verify");
});
