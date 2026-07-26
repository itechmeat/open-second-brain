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
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";
import {
  LINEAGE_RECORD_STATUS,
  readLineageGapReport,
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

    // The behaviour the name promises: a destroyed ledger is REPORTED,
    // not silently verified clean. `not.toThrow()` asserted nothing of
    // the kind - it passed against a verifier that returned ok:true.
    const report = verifyLineageLedger(tmp);
    expect(report.ok).toBe(false);
    expect(report.skipped).toBe(2);
    expect(report.notices.some((n) => n.code === DEGRADATION_CODE.lineageChainBroken)).toBe(true);
  });

  test("an all-truncated-JSON ledger is reported, never clean", () => {
    const path = sessionLineageLedgerPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"sid":"s-1","at":"2026-06-10T08:0\n{"sid":"s-2"\n', "utf8");
    const report = verifyLineageLedger(tmp);
    expect(report.lines).toBe(0);
    expect(report.skipped).toBe(2);
    expect(report.ok).toBe(false);
  });

  test("a ledger that exists but holds nothing parseable is not 'no ledger'", () => {
    const path = sessionLineageLedgerPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "\n\n", "utf8");
    const report = verifyLineageLedger(tmp);
    expect(report.exists).toBe(true);
    expect(report.lines).toBe(0);
    // A present-but-empty ledger has no findings of its own; the point
    // is that a consumer can tell it apart from an absent one.
    expect(verifyLineageLedger(join(tmp, "elsewhere")).exists).toBe(false);
  });

  test("an unreadable ledger is reported rather than counted as clean", () => {
    const path = sessionLineageLedgerPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ sid: "s", at: "x", event: "Stop" })}\n`, "utf8");
    chmodSync(path, 0o000);
    try {
      const report = verifyLineageLedger(tmp);
      // Running as root defeats the mode bits; skip rather than assert
      // a permission the environment does not enforce.
      if (report.readable) return;
      expect(report.ok).toBe(false);
      expect(report.notices.some((n) => n.detail.includes("could not be read"))).toBe(true);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("a line stripped of its chain fields is reported once chained lines exist", () => {
    record("s-1", T0);
    record("s-2", T0 + 1_000);
    record("s-3", T0 + 2_000);
    const path = sessionLineageLedgerPath(tmp);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const { seq: _seq, prev: _prev, h: _h, ...stripped } = JSON.parse(lines[1]!) as RawLine;
    lines[1] = JSON.stringify(stripped);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    // Stripping the chain fields made the line `legacy`, which reset
    // `previous` and left the FOLLOWING line's `prev` unchecked - so a
    // tampered middle line passed with ok:true.
    const report = verifyLineageLedger(tmp);
    expect(report.legacy).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.notices.some((n) => n.code === DEGRADATION_CODE.lineageChainBroken)).toBe(true);
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

// ----- the gap sidecar's own failure modes ---------------------------------

describe("the gap sidecar is bounded, aged, and honest about both", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Drop `count` observations by holding the ledger's writer lock. */
  function dropMany(count: number): void {
    const handle = acquireLockSync(sessionLineageLedgerPath(tmp));
    try {
      for (let i = 0; i < count; i++) {
        expect(record(`d-${i}`, T0 + i).status).toBe(LINEAGE_RECORD_STATUS.dropped);
      }
    } finally {
      handle.release();
    }
  }

  function gapFileLines(): string[] {
    return readFileSync(sessionLineageGapsPath(tmp), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  }

  test("a saturated sidecar reports the TOTAL, not the retained count", () => {
    dropMany(400);
    const report = readLineageGapReport(tmp);
    // 400 drops presented as 256 was the defect: the cap is real, and
    // what it removed is carried as an explicit count beside it.
    expect(report.records.length).toBe(256);
    expect(report.truncated).toBe(true);
    expect(report.discarded).toBe(400 - 256);
    expect(report.total).toBe(400);
  });

  test("verification names the unlisted remainder instead of dropping it", () => {
    dropMany(400);
    const report = verifyLineageLedger(tmp);
    expect(report.droppedObservations).toBe(400);
    expect(report.gapsTruncated).toBe(true);
    // Bounded itemization, with the rest counted rather than silently cut.
    expect(report.notices.length).toBeLessThan(40);
    expect(report.notices.some((n) => n.detail.includes("not itemized"))).toBe(true);
  });

  /** An oversized sidecar, as a crash inside the trim window leaves it. */
  function seedOversizedSidecar(count: number): void {
    const path = sessionLineageGapsPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      path,
      Array.from({ length: count }, (_, i) =>
        JSON.stringify({
          sid: `old-${i}`,
          at: now,
          rat: now,
          event: "Stop",
          reason: "write-failed",
        }),
      ).join("\n") + "\n",
      "utf8",
    );
  }

  test("a stale trim lock does not disable the bound", () => {
    seedOversizedSidecar(300);
    const gapsLock = `${sessionLineageGapsPath(tmp)}.lock`;
    writeFileSync(gapsLock, "9999999\n", "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(gapsLock, old, old);
    try {
      // Before the reclaim path the trim skipped outright on ELOCKED, so
      // one crash inside that window left the sidecar growing forever.
      dropMany(1);
      expect(readLineageGapReport(tmp).records.length).toBe(256);
      expect(gapFileLines().length).toBe(257); // 256 records + the marker
    } finally {
      rmSync(gapsLock, { force: true });
    }
  });

  test("a LIVE trim lock is respected — no breaker on a lock in use", () => {
    seedOversizedSidecar(300);
    const handle = acquireLockSync(sessionLineageGapsPath(tmp));
    try {
      dropMany(1);
      // Untrimmed: a lock that a live process holds is never taken away.
      expect(gapFileLines().length).toBe(301);
    } finally {
      handle.release();
    }
  });

  test("gaps age out, so one contention burst does not pin ok:false forever", () => {
    dropMany(3);
    expect(verifyLineageLedger(tmp).ok).toBe(false);
    const later = Date.now() + 8 * DAY_MS;
    expect(readLineageGapReport(tmp, { nowMs: later }).total).toBe(0);
    expect(verifyLineageLedger(tmp, { nowMs: later }).ok).toBe(true);
  });

  test("aging keys off when the gap was RECORDED, not the observation's own clock", () => {
    // Every observation here is stamped in the past (T0 is 2026-06-10);
    // aging on `at` would expire a gap written this instant.
    dropMany(2);
    expect(readLineageGapReport(tmp).total).toBe(2);
  });

  test("the truncation marker expires with the records it counted", () => {
    dropMany(400);
    const later = Date.now() + 8 * DAY_MS;
    const report = readLineageGapReport(tmp, { nowMs: later });
    expect(report.total).toBe(0);
    expect(report.truncated).toBe(false);
  });

  test("the drop notice NAMES the lock file", () => {
    const lockPath = `${sessionLineageLedgerPath(tmp)}.lock`;
    const handle = acquireLockSync(sessionLineageLedgerPath(tmp));
    let result;
    try {
      result = record("s-blocked", T0);
    } finally {
      handle.release();
    }
    expect(result.notice?.path).toBe(lockPath);
    expect(result.notice?.detail).toContain(lockPath);
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
