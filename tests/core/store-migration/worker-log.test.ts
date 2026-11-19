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
  trimLogToTail,
  WORKER_LOG_CAP_BYTES,
  WORKER_LOG_KEEP_BYTES,
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
