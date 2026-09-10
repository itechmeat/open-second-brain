/**
 * The doctor names a Brain log shard that stopped linking up
 * (who-wrote-what, Task E).
 *
 * The chain is report-only, so the doctor is the surface an operator who
 * is not looking for it reaches it through. One finding per broken
 * shard, naming the file and the line, because "the log was edited" with
 * no file to open is a dead end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { LOG_CHAIN_BROKEN_CODE } from "../../../src/core/brain/doctor/log-chain-check.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { logJsonlPath, logShardJsonlPath } from "../../../src/core/brain/paths.ts";

const DATE = "2026-06-02";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-log-chain-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
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

/** Remove the `line`th (1-based) row of a shard, breaking its chain. */
function dropLine(path: string, line: number): void {
  const rows = readFileSync(path, "utf8").trim().split("\n");
  rows.splice(line - 1, 1);
  writeFileSync(path, rows.join("\n") + "\n", "utf8");
}

describe("the log-chain check", () => {
  test("says nothing about a log nobody edited", async () => {
    appendMany(3);
    const report = await runDoctor(vault);
    expect(report.warnings.filter((i) => i.code === LOG_CHAIN_BROKEN_CODE)).toHaveLength(0);
    expect(report.errors.filter((i) => i.code === LOG_CHAIN_BROKEN_CODE)).toHaveLength(0);
  });

  test("says nothing about a vault whose log holds only pre-chain lines", async () => {
    writeFileSync(
      logJsonlPath(vault, DATE),
      JSON.stringify({ ts: `${DATE}T09:00:00Z`, kind: "note", payload: { text: "legacy" } }) + "\n",
      "utf8",
    );
    const report = await runDoctor(vault);
    expect(report.warnings.filter((i) => i.code === LOG_CHAIN_BROKEN_CODE)).toHaveLength(0);
  });

  test("warns once per broken shard, naming the shard and the line", async () => {
    appendMany(3);
    dropLine(logJsonlPath(vault, DATE), 2);

    const report = await runDoctor(vault);
    const found = report.warnings.filter((i) => i.code === LOG_CHAIN_BROKEN_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.path).toBe(logJsonlPath(vault, DATE));
    expect(found[0]!.message).toContain("line 2");
    expect(found[0]!.message).toContain("removed or reordered");
  });

  test("reports two broken shards as two findings", async () => {
    appendMany(3, "devalpha");
    appendMany(3, "devbeta");
    dropLine(logShardJsonlPath(vault, DATE, "devalpha"), 2);
    dropLine(logShardJsonlPath(vault, DATE, "devbeta"), 2);

    const report = await runDoctor(vault);
    const found = report.warnings.filter((i) => i.code === LOG_CHAIN_BROKEN_CODE);
    expect(found).toHaveLength(2);
    expect(found.map((i) => i.path).toSorted()).toEqual(
      [
        logShardJsonlPath(vault, DATE, "devalpha"),
        logShardJsonlPath(vault, DATE, "devbeta"),
      ].toSorted(),
    );
  });

  test("a break in one shard leaves the other shard unreported", async () => {
    appendMany(3, "devalpha");
    appendMany(3, "devbeta");
    dropLine(logShardJsonlPath(vault, DATE, "devalpha"), 2);

    const report = await runDoctor(vault);
    const found = report.warnings.filter((i) => i.code === LOG_CHAIN_BROKEN_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe(logShardJsonlPath(vault, DATE, "devalpha"));
  });
});

describe("the exit", () => {
  test("the finding carries the command that shows the whole picture", () => {
    const signal = DIAGNOSTIC_SIGNALS.get(LOG_CHAIN_BROKEN_CODE);
    expect(signal).toBeDefined();
    expect(signal!.nextCommand).toBe("o2b brain log verify");
    // Nothing may rewrite an audit trail to make it verify.
    expect(signal!.autoRepairable).toBe(false);
  });
});
