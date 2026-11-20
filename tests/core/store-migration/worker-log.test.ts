/**
 * The automatic migration worker's error output log stays small within
 * one run: the spawn opens it for appending, and the worker keeps it to
 * its newest tail once it passes the cap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSelfDetached } from "../../../src/core/maintenance/o2b-command.ts";
import {
  beginWorkerLogAttempt,
  latestWorkerLogAttempt,
  trimLogToTail,
  WORKER_LOG_ATTEMPTS_KEPT,
  WORKER_LOG_CAP_BYTES,
  WORKER_LOG_KEEP_BYTES,
  workerLogAttemptHeader,
} from "../../../src/core/store-migration/worker-log.ts";

const CHILD = join(import.meta.dir, "fixtures", "worker-log-child.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "osb-worker-log-"));
  dirs.push(d);
  return d;
}

describe("the worker log is bounded", () => {
  test("a worker that writes far past the cap leaves only its newest tail", async () => {
    const log = join(dir(), "w.worker.log");
    writeFileSync(log, "an earlier run\n");
    const proc = spawnSelfDetached([process.execPath, "run", CHILD, log, "3000"], {
      stderrLog: log,
    });
    await proc.exited;
    const text = readFileSync(log, "utf8");
    expect(statSync(log).size).toBeLessThanOrEqual(WORKER_LOG_CAP_BYTES);
    expect(text.endsWith("the last line\n")).toBe(true);
    expect(text).not.toContain("an earlier run");
    // Whole lines only.
    expect(text.startsWith("line ")).toBe(true);
  });

  test("the trim keeps the newest whole lines, and leaves a small log alone", () => {
    const log = join(dir(), "t.log");
    const big =
      Array.from({ length: 1000 }, (_, i) => `row ${i} ${"y".repeat(100)}`).join("\n") + "\n";
    writeFileSync(log, big);
    expect(trimLogToTail(log)).toBe(true);
    const text = readFileSync(log, "utf8");
    expect(text.length).toBeLessThanOrEqual(WORKER_LOG_KEEP_BYTES);
    expect(text.startsWith("row ")).toBe(true);
    expect(text.endsWith(`row 999 ${"y".repeat(100)}\n`)).toBe(true);
    writeFileSync(log, "small\n");
    expect(trimLogToTail(log)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("small\n");
  });
});

describe("attempts in the worker log", () => {
  test("a new attempt keeps what the attempts before it wrote, the last few only", () => {
    const log = join(dir(), "w.worker.log");
    writeFileSync(log, "a killed run's last step\n");
    for (let i = 1; i <= WORKER_LOG_ATTEMPTS_KEPT + 1; i++) {
      beginWorkerLogAttempt(
        log,
        workerLogAttemptHeader(new Date(Date.UTC(2026, 10, 20, 0, i)), `n${i}`),
      );
      writeFileSync(log, `step of attempt ${i}\n`, { flag: "a" });
    }
    const text = readFileSync(log, "utf8");
    // The oldest parts are gone, the last attempts and their separators stay.
    expect(text).not.toContain("a killed run's last step");
    expect(text).not.toContain("step of attempt 1\n");
    for (let i = 2; i <= WORKER_LOG_ATTEMPTS_KEPT + 1; i++) {
      expect(text).toContain(`step of attempt ${i}\n`);
      expect(text).toContain(`n${i} =====`);
    }
    expect(latestWorkerLogAttempt(text).trim()).toBe(
      `step of attempt ${WORKER_LOG_ATTEMPTS_KEPT + 1}`,
    );
  });

  test("the attempt after a killed one keeps the killed run's lines", () => {
    const log = join(dir(), "w.worker.log");
    writeFileSync(log, "2026-11-20T07:25:40.000Z importing, 186368 of about 379051\n");
    beginWorkerLogAttempt(log, workerLogAttemptHeader(new Date(), "started by process 1"));
    const text = readFileSync(log, "utf8");
    expect(text).toContain("186368 of about 379051");
    expect(latestWorkerLogAttempt(text)).toBe("");
  });
});
