/**
 * Tests for src/core/brain/operator-snapshot.ts - the unified operator
 * status snapshot (O3, t_9f9c5466).
 *
 * A healthy vault snapshots to an all-clear; a vault with detected issues
 * produces problem lines, each carrying the exact next command supplied by
 * the O2 diagnostics-signal registry (never hardcoded in the renderer).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOperatorSnapshot,
  renderOperatorSnapshot,
} from "../../src/core/brain/operator-snapshot.ts";
import { resolveSignal } from "../../src/core/brain/diagnostics.ts";
import { brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-snapshot-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(brainConfigPath(tmp), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildOperatorSnapshot", () => {
  test("a clean vault snapshots to all-clear with no problems", async () => {
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.healthy).toBe(true);
    expect(snap.problems).toEqual([]);
    expect(snap.stateFiles.config).toBe(true);
    const text = renderOperatorSnapshot(snap);
    expect(text).toContain("all clear");
    expect(text).not.toContain("Problems:");
  });

  test("a dangling workrun surfaces a doctor-warning problem with a next command", async () => {
    const runs = join(tmp, "Brain", "log", "dream-runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "run-x.jsonl"),
      JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-x" }) + "\n",
      "utf8",
    );
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.healthy).toBe(false);
    const dw = snap.problems.find((p) => p.code === "doctor-warnings");
    expect(dw).toBeDefined();
    // The hint travels with the signal definition, not the formatter.
    expect(dw!.nextCommand).toBe(resolveSignal("doctor-warnings").nextCommand);
    const text = renderOperatorSnapshot(snap);
    expect(text).toContain("Problems:");
    expect(text).toContain(`-> next: ${dw!.nextCommand}`);
  });

  test("a missing config surfaces a state-file problem", async () => {
    rmSync(brainConfigPath(tmp), { force: true });
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.stateFiles.config).toBe(false);
    const sf = snap.problems.find((p) => p.code === "state-file");
    expect(sf).toBeDefined();
    expect(sf!.nextCommand).toBe("o2b brain init");
  });

  test("every problem line's next command matches its signal definition", async () => {
    const runs = join(tmp, "Brain", "log", "dream-runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "run-y.jsonl"),
      JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-y" }) + "\n",
      "utf8",
    );
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    for (const p of snap.problems) {
      expect(p.nextCommand).toBe(resolveSignal(p.code).nextCommand);
      expect(p.nextCommand.startsWith("o2b ")).toBe(true);
    }
  });
});

describe("buildOperatorSnapshot store group (t_cfe2ce5d)", () => {
  /** The search index path the snapshot's own probe reads, for lock staging. */
  function dbPath(): string {
    return resolveSearchConfig({ vault: tmp }).dbPath;
  }

  /**
   * The lock directory `proper-lockfile` takes: `mkdirSync(`${dbPath}.lock`)`,
   * the exact shape `lockfile.lockSync` creates (getLockFile in
   * proper-lockfile/lib/lockfile.js).
   */
  function takeWriterLock(): string {
    const lockDir = `${dbPath()}.lock`;
    mkdirSync(lockDir, { recursive: true });
    return lockDir;
  }

  test("no lock directory reads free", async () => {
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.store.writerLock).toBe("free");
    expect(snap.store.writerLockReason).toBeNull();
    expect(snap.store.writerLockAgeMs).toBeNull();
    expect(snap.store.writerLockPath).toBe(dbPath());
    expect(snap.store.thisCaller).toBe("read-only");
  });

  test("a lock directory created the way proper-lockfile takes the lock reads held with a non-negative age", async () => {
    takeWriterLock();
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.store.writerLock).toBe("held");
    expect(snap.store.writerLockAgeMs).not.toBeNull();
    expect(snap.store.writerLockAgeMs!).toBeGreaterThanOrEqual(0);
    // v1 truth: the lock record is a bare directory carrying no identity,
    // so the owner field reads null rather than inventing a holder.
    expect(snap.store.writerLockOwner).toBeNull();
  });

  test("an injected throw reads unknown with the errno in the reason", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const snap = await buildOperatorSnapshot(tmp, {
      now: new Date("2026-07-18T12:00:00Z"),
      writerLockHeldAt: () => {
        throw failure;
      },
    });
    expect(snap.store.writerLock).toBe("unknown");
    expect(snap.store.writerLockReason).toContain("EACCES");
    expect(snap.store.writerLockAgeMs).toBeNull();
  });

  test("a held lock is a live writer, not a fault: healthy stays true and problems are unchanged", async () => {
    const before = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    takeWriterLock();
    const held = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(held.healthy).toBe(true);
    expect(held.problems).toEqual(before.problems);
  });

  test("the renderer prints the store line on both branches", async () => {
    const clear = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(renderOperatorSnapshot(clear)).toContain("store: writer lock free");

    takeWriterLock();
    const held = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    const heldText = renderOperatorSnapshot(held);
    expect(heldText).toContain("store: writer lock held");
    // The owner's absence is a stated measurement, not a gap.
    expect(heldText).toContain("carries no identity");
    // The refusal is scoped to what the lock actually gates - index
    // writers only. The brain lane serializes on its own lock files, so
    // an unscoped "a write now would refuse" told every agent reading
    // this card that a memory write would fail when it would not (M8).
    expect(heldText).toContain(
      "an index write (o2b search index / reindex) would refuse with INDEX_LOCKED",
    );
    expect(heldText).toContain("vault and memory writes are not gated by this lock");
    expect(heldText).toContain("this caller read-only");

    const unclear = await buildOperatorSnapshot(tmp, {
      now: new Date("2026-07-18T12:00:00Z"),
      writerLockHeldAt: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const unclearText = renderOperatorSnapshot(unclear);
    expect(unclearText).toContain("store: writer lock state unknown");
    expect(unclearText).toContain("EACCES");
    expect(unclearText).toContain("this caller read-only");
  });
});
