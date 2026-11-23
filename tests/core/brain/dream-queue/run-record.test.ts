/**
 * The run of a dream session and its marker (change `dream-launched-agent`,
 * design D2; spec "A run authorises the operations, a marker does not",
 * task 1.1).
 */
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  beginsWithDreamSessionLine,
  dreamSessionLine,
  insideDreamSession,
} from "../../../../src/core/brain/dream-queue/dream-session.ts";
import {
  appendDreamRunCall,
  checkDreamRun,
  createDreamRun,
  dreamRunsDir,
  readDreamRun,
  readDreamRunCalls,
  removeDreamRun,
  sweepStaleDreamRuns,
} from "../../../../src/core/brain/dream-queue/run-record.ts";
import { tempDirs } from "../../../helpers/temp-dir.ts";

const mkTemp = tempDirs();
const NOW = Date.UTC(2026, 10, 22, 9, 0, 0);

function run(dir: string, budgetMs = 60_000) {
  return createDreamRun(dir, {
    ownerRevision: "rev-1",
    budgetMs,
    operations: ["rollup-summary"],
    privateAllowed: true,
    itemBudget: 5,
    agent: "fake",
    now: NOW,
  });
}

describe("dream run records", () => {
  test("written with mode 0600 and found by id and token", () => {
    const dir = mkTemp("o2b-run-");
    const { record, token } = run(dir);
    const path = join(dreamRunsDir(dir), `${record.run}.json`);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readDreamRun(dir, record.run)?.token_sha256).toBe(record.token_sha256);
    expect(JSON.stringify(readDreamRun(dir, record.run))).not.toContain(token);
    const check = checkDreamRun(dir, { run: record.run, token, ownerRevision: "rev-1", now: NOW });
    expect(check.ok).toBe(true);
  });

  test("a wrong token, an expired run and another owner revision are refused", () => {
    const dir = mkTemp("o2b-run-");
    const { record, token } = run(dir);
    const base = { run: record.run, ownerRevision: "rev-1", now: NOW };
    expect(checkDreamRun(dir, { ...base, token: "0".repeat(64) })).toMatchObject({ ok: false });
    expect(checkDreamRun(dir, { ...base, token, now: NOW + 60_000 })).toMatchObject({
      ok: false,
      reason: "the dream run expired",
    });
    expect(checkDreamRun(dir, { ...base, token, ownerRevision: "rev-2" })).toMatchObject({
      ok: false,
    });
    expect(checkDreamRun(dir, { ...base, token, ownerRevision: null })).toMatchObject({
      ok: false,
    });
    expect(checkDreamRun(dir, { ...base, run: undefined, token })).toMatchObject({ ok: false });
    expect(checkDreamRun(dir, { ...base, run: "../../etc", token })).toMatchObject({ ok: false });
  });

  test("a stale record is swept, a live one is kept", () => {
    const dir = mkTemp("o2b-run-");
    const stale = run(dir, 1_000).record;
    const live = run(dir, 600_000).record;
    expect(sweepStaleDreamRuns(dir, NOW + 5_000)).toEqual([stale.run]);
    expect(readDreamRun(dir, stale.run)).toBeNull();
    expect(readDreamRun(dir, live.run)).not.toBeNull();
    removeDreamRun(dir, live.run);
    expect(readDreamRun(dir, live.run)).toBeNull();
  });

  test("the call log keeps one line per call, with no content", () => {
    const dir = mkTemp("o2b-run-");
    const { record } = run(dir);
    appendDreamRunCall(dir, record.run, { tool: "dream_work_take", outcome: "item" });
    appendDreamRunCall(dir, record.run, { tool: "dream_work_finish", outcome: "released 0" });
    expect(readDreamRunCalls(dir, record.run).map((c) => [c.tool, c.outcome])).toEqual([
      ["dream_work_take", "item"],
      ["dream_work_finish", "released 0"],
    ]);
  });
});

describe("the marker", () => {
  test("insideDreamSession is true only with the marker", () => {
    expect(insideDreamSession({})).toBe(false);
    expect(insideDreamSession({ OPEN_SECOND_BRAIN_DREAM_RUN: "" })).toBe(false);
    expect(insideDreamSession({ OPEN_SECOND_BRAIN_DREAM_TOKEN: "x" })).toBe(false);
    expect(insideDreamSession({ OPEN_SECOND_BRAIN_DREAM_RUN: "run-1234" })).toBe(true);
  });

  test("the session line opens a dream session's text; a later quote does not", () => {
    const line = dreamSessionLine("0b0c3a2e-1111-4222-8333-444455556666");
    expect(beginsWithDreamSessionLine(`${line}\nCall dream_work_take.`)).toBe(true);
    expect(beginsWithDreamSessionLine(`Look at this: ${line}`)).toBe(false);
    expect(beginsWithDreamSessionLine(undefined)).toBe(false);
  });
});
