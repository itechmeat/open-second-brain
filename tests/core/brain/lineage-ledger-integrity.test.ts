/**
 * Lineage ledger integrity (context-integrity-gates, Unit D / Task 12).
 *
 * The ledger was append-only JSONL with no sequence numbers, no hash
 * chain, no writer lock and no verification. Four losses are pinned here
 * as defects:
 *
 *   - compaction folded the file to ONE SUMMARY LINE PER SESSION,
 *     destroying per-session event history and `firstSeenMs` outright;
 *   - its re-serializer hard-coded its field list, so any field added to
 *     the writer vanished at the next compaction;
 *   - the compaction branch was a read-modify-write with no mutual
 *     exclusion, so a concurrent writer's observation was clobbered;
 *   - a dropped observation left no trace at all.
 *
 * The read path stays fail-soft throughout: verification is a separate
 * function that REPORTS, and `readLineageLedger` still returns an empty
 * map rather than throwing on a corrupt file, because the anticipatory
 * cache and the lifecycle hook both depend on that.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";
import {
  LINEAGE_RECORD_STATUS,
  readLineageLedger,
  recordLineageObservation,
  sessionLineageGapsPath,
  sessionLineageLedgerPath,
} from "../../../src/core/brain/lineage/ledger.ts";
import { verifyLineageLedger } from "../../../src/core/brain/lineage/verify.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ledger-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-06-10T08:00:00Z");

interface RawLine {
  readonly sid: string;
  readonly at: string;
  readonly event: string;
  readonly seq?: number;
  readonly prev?: string | null;
  readonly h?: string;
  readonly [key: string]: unknown;
}

function rawLines(vault: string): RawLine[] {
  const raw = readFileSync(sessionLineageLedgerPath(vault), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawLine);
}

function record(sessionId: string, atMs: number, over: Record<string, unknown> = {}) {
  return recordLineageObservation(tmp, {
    sessionId,
    at: new Date(atMs).toISOString(),
    event: "Stop",
    ...over,
  });
}

// ----- sequence numbers and the hash chain ---------------------------------

describe("recordLineageObservation — sequence numbers and hash chain", () => {
  test("allocates a contiguous sequence and links each line to the last", () => {
    record("s-1", T0);
    record("s-2", T0 + 1_000);
    record("s-3", T0 + 2_000);
    const lines = rawLines(tmp);
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    expect(lines[0]!.prev).toBeNull();
    expect(lines[1]!.prev).toBe(lines[0]!.h!);
    expect(lines[2]!.prev).toBe(lines[1]!.h!);
    expect(lines[2]!.h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reports the allocated sequence to the caller", () => {
    expect(record("s-1", T0)).toMatchObject({
      status: LINEAGE_RECORD_STATUS.appended,
      seq: 1,
    });
    expect(record("s-2", T0 + 1_000)).toMatchObject({
      status: LINEAGE_RECORD_STATUS.appended,
      seq: 2,
    });
  });

  test("a clean ledger verifies with no findings", () => {
    record("s-1", T0);
    record("s-1", T0 + 1_000, { event: "PostCompact", compressionEvidence: true });
    const report = verifyLineageLedger(tmp);
    expect(report.ok).toBe(true);
    expect(report.notices).toHaveLength(0);
    expect(report.chained).toBe(2);
    expect(report.legacy).toBe(0);
  });
});

describe("verifyLineageLedger — reports, never refuses", () => {
  test("a tampered line is reported with its sequence number", () => {
    record("s-1", T0);
    record("s-2", T0 + 1_000);
    record("s-3", T0 + 2_000);
    const path = sessionLineageLedgerPath(tmp);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const tampered = JSON.parse(lines[1]!) as RawLine;
    lines[1] = JSON.stringify({ ...tampered, cwd: "/somewhere-else" });
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const report = verifyLineageLedger(tmp);
    expect(report.ok).toBe(false);
    expect(report.notices.some((n) => n.code === DEGRADATION_CODE.lineageChainBroken)).toBe(true);
    expect(report.notices.some((n) => n.detail.includes("2"))).toBe(true);
  });

  test("a tampered ledger does NOT prevent resolution", () => {
    record("s-1", T0, { cwd: "/work" });
    const path = sessionLineageLedgerPath(tmp);
    const line = JSON.parse(readFileSync(path, "utf8").trim()) as RawLine;
    writeFileSync(path, `${JSON.stringify({ ...line, cwd: "/tampered" })}\n`, "utf8");
    expect(readLineageLedger(tmp).get("s-1")?.cwd).toBe("/tampered");
    expect(verifyLineageLedger(tmp).ok).toBe(false);
  });

  test("a removed line is reported as a sequence gap", () => {
    record("s-1", T0);
    record("s-2", T0 + 1_000);
    record("s-3", T0 + 2_000);
    const path = sessionLineageLedgerPath(tmp);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    writeFileSync(path, `${lines[0]!}\n${lines[2]!}\n`, "utf8");
    const report = verifyLineageLedger(tmp);
    expect(report.ok).toBe(false);
    expect(report.notices[0]!.code).toBe(DEGRADATION_CODE.lineageChainBroken);
  });

  test("a missing ledger verifies clean rather than throwing", () => {
    const report = verifyLineageLedger(tmp);
    expect(report.ok).toBe(true);
    expect(report.lines).toBe(0);
  });

  test("a wholly corrupt file is reported, and the read path still returns empty", () => {
    const path = sessionLineageLedgerPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-json\n{\n", "utf8");
    expect(readLineageLedger(tmp).size).toBe(0);
    expect(() => verifyLineageLedger(tmp)).not.toThrow();
  });

  test("a pre-chain ledger is counted as legacy, not as a break", () => {
    const path = sessionLineageLedgerPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ sid: "old-1", at: new Date(T0).toISOString(), event: "Stop" })}\n`,
      "utf8",
    );
    const report = verifyLineageLedger(tmp);
    expect(report.legacy).toBe(1);
    expect(report.ok).toBe(true);

    // A new line appended after legacy content chains from scratch.
    record("s-1", T0 + 1_000);
    const after = verifyLineageLedger(tmp);
    expect(after.ok).toBe(true);
    expect(after.chained).toBe(1);
  });
});

// ----- lossless compaction -------------------------------------------------

describe("recordLineageObservation — compaction is lossless", () => {
  function fill(count: number, sessionId = "chatty"): void {
    for (let i = 0; i < count; i++) {
      record(sessionId, T0 + i * 1_000, { event: `E${i}` });
    }
  }

  test("preserves firstSeenMs — the summary fold dropped it entirely", () => {
    fill(600);
    const entry = readLineageLedger(tmp).get("chatty")!;
    // The old fold rewrote one line per session stamped at lastSeenMs,
    // so firstSeenMs and lastSeenMs collapsed onto the same instant.
    expect(entry.firstSeenMs).toBeLessThan(entry.lastSeenMs);
  });

  test("preserves per-session event history", () => {
    fill(600);
    const events = rawLines(tmp).filter((line) => line.sid === "chatty");
    expect(events.length).toBeGreaterThan(1);
    expect(new Set(events.map((line) => line.event)).size).toBe(events.length);
  });

  test("preserves a field the writer emits that no re-serializer knows about", () => {
    // Stands in for any field a future writer adds. The old compaction
    // re-serialized from a hard-coded field list and would have dropped
    // this silently; verbatim retention cannot.
    fill(510);
    const path = sessionLineageLedgerPath(tmp);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const last = JSON.parse(lines.at(-1)!) as RawLine;
    lines[lines.length - 1] = JSON.stringify({ ...last, unknown_future_field: "keep-me" });
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    // Cross the cap so a compaction rewrite runs while the marked line
    // is still inside the retention window.
    fill(3, "tail");
    expect(rawLines(tmp).length).toBeLessThanOrEqual(512);
    expect(readFileSync(path, "utf8").includes("keep-me")).toBe(true);
  });

  test("keeps the file bounded and the chain intact across compaction", () => {
    fill(600);
    const lines = rawLines(tmp);
    expect(lines.length).toBeLessThanOrEqual(512);
    expect(lines.length).toBeGreaterThan(1);
    // Retained lines keep their original sequence numbers, so the chain
    // is still contiguous even though the head was dropped.
    expect(lines[0]!.seq).toBeGreaterThan(1);
    expect(verifyLineageLedger(tmp).ok).toBe(true);
  });

  test("the oldest sessions still age out", () => {
    for (let i = 0; i < 600; i++) record(`s-${i}`, T0 + i * 1_000);
    const state = readLineageLedger(tmp);
    expect(state.has("s-599")).toBe(true);
    expect(state.has("s-0")).toBe(false);
  });
});

// ----- mutual exclusion ----------------------------------------------------

describe("recordLineageObservation — writer lock", () => {
  test("a held lock drops the observation and records a NAMED gap", () => {
    record("s-1", T0);
    const handle = acquireLockSync(sessionLineageLedgerPath(tmp));
    let result;
    try {
      result = record("s-2", T0 + 1_000);
    } finally {
      handle.release();
    }
    expect(result.status).toBe(LINEAGE_RECORD_STATUS.dropped);
    expect(result.notice?.code).toBe(DEGRADATION_CODE.lineageObservationDropped);
    // The observation is gone, but its absence is on the record.
    expect(readLineageLedger(tmp).has("s-2")).toBe(false);
    expect(readFileSync(sessionLineageGapsPath(tmp), "utf8")).toContain("s-2");
  });

  test("verification surfaces recorded gaps as dropped observations", () => {
    record("s-1", T0);
    const handle = acquireLockSync(sessionLineageLedgerPath(tmp));
    try {
      record("s-2", T0 + 1_000);
    } finally {
      handle.release();
    }
    const report = verifyLineageLedger(tmp);
    expect(report.droppedObservations).toBe(1);
    expect(report.notices.some((n) => n.code === DEGRADATION_CODE.lineageObservationDropped)).toBe(
      true,
    );
    expect(report.ok).toBe(false);
  });

  test("the lock is released after a successful write", () => {
    record("s-1", T0);
    // If the previous write leaked its lock this would be dropped.
    expect(record("s-2", T0 + 1_000).status).toBe(LINEAGE_RECORD_STATUS.appended);
  });
});

describe("recordLineageObservation — genuinely concurrent writers", () => {
  test("every attempt either lands or is recorded as a gap, and the chain holds", async () => {
    // Real OS processes, not simulated contention: four `bun` children
    // hammering one ledger seeded to just under the compaction cap, so
    // the read-modify-write branch runs while they overlap.
    for (let i = 0; i < 500; i++) record(`seed-${i}`, T0 + i * 1_000);

    const ledgerModule = join(import.meta.dir, "../../../src/core/brain/lineage/ledger.ts");
    const script = join(tmp, "writer.ts");
    writeFileSync(
      script,
      [
        `import { recordLineageObservation } from ${JSON.stringify(ledgerModule)};`,
        "const [vault, tag, count] = process.argv.slice(2);",
        "let appended = 0; let dropped = 0;",
        "for (let i = 0; i < Number(count); i++) {",
        "  const result = recordLineageObservation(vault, {",
        "    sessionId: `${tag}-${i}`,",
        "    at: new Date().toISOString(),",
        "    event: 'Stop',",
        "  });",
        "  if (result.status === 'appended') appended++; else dropped++;",
        "}",
        "process.stdout.write(JSON.stringify({ appended, dropped }));",
      ].join("\n"),
      "utf8",
    );

    const writers = 4;
    const perWriter = 25;
    const procs = Array.from({ length: writers }, (_, index) =>
      Bun.spawn(["bun", script, tmp, `w${index}`, String(perWriter)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      procs.map(async (proc) => {
        const text = await new Response(proc.stdout).text();
        await proc.exited;
        return JSON.parse(text) as { appended: number; dropped: number };
      }),
    );

    const appended = results.reduce((sum, r) => sum + r.appended, 0);
    const dropped = results.reduce((sum, r) => sum + r.dropped, 0);
    // Conservation: nothing vanishes without a name.
    expect(appended + dropped).toBe(writers * perWriter);

    const report = verifyLineageLedger(tmp);
    expect(report.droppedObservations).toBe(dropped);
    // The only findings, if any, are the named gaps - never a broken chain.
    expect(report.notices.every((n) => n.code === DEGRADATION_CODE.lineageObservationDropped)).toBe(
      true,
    );

    // Every landed observation is readable, and none clobbered another.
    const state = readLineageLedger(tmp);
    const landed = [...state.keys()].filter((sid) => sid.startsWith("w")).length;
    expect(landed).toBe(appended);
  }, 30_000);
});
