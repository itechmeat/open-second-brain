/**
 * The background child a stale read starts: `o2b search index --freshen
 * <token>` records its outcome in the per-device state file, backs off
 * after a failure, writes a metric row only when it changed something or
 * failed, and releases the claim it was handed in every case.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listMetrics } from "../../src/core/brain/metrics.ts";
import {
  claimFreshen,
  FRESHEN_CLAIM_FILE,
  INDEX_FRESHEN_SURFACE,
  markFreshenPending,
  readFreshenPending,
  readFreshenState,
} from "../../src/core/search/freshen.ts";
import { acquireWriterLockSync } from "../../src/core/search/store/writer-lock.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let derived: string;
let configPath: string;

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-freshen-child-"));
  vault = join(tmp, "vault");
  derived = join(vault, ".open-second-brain");
  mkdirSync(join(vault, "notes"), { recursive: true });
  mkdirSync(derived, { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(join(vault, "notes", "a.md"), "# A\n\nfirst note about herons.\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function freshenRun(): Promise<{ returncode: number }> {
  const token = claimFreshen(derived, Date.now());
  expect(token).toBeString();
  return runCli(["search", "index", "--freshen", token!], { env: env() });
}

test("a completed run records its outcome, changes and a metric row, and releases the claim", async () => {
  const result = await freshenRun();
  expect(result.returncode).toBe(0);
  const state = readFreshenState(derived);
  expect(state.lastOutcome).toBe("completed");
  expect(state.lastChanged).toBe(1);
  expect(state.failures).toBe(0);
  expect(state.backoffUntil).toBeNull();
  expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);
  const rows = listMetrics(vault, { surface: INDEX_FRESHEN_SURFACE });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload["outcome"]).toBe("completed");
});

test("a run that changed nothing writes no metric row", async () => {
  await freshenRun();
  await freshenRun();
  expect(readFreshenState(derived).lastChanged).toBe(0);
  expect(listMetrics(vault, { surface: INDEX_FRESHEN_SURFACE })).toHaveLength(1);
});

test("a failed run backs off, doubling on the next failure, and still releases the claim", async () => {
  // A directory squatting on the index path makes every open fail.
  mkdirSync(join(derived, "brain.sqlite"));
  const before = Date.now();
  const first = await freshenRun();
  expect(first.returncode).not.toBe(0);
  let state = readFreshenState(derived);
  expect(state.lastOutcome).toBe("failed");
  expect(state.failures).toBe(1);
  expect(state.lastError).toBeString();
  const firstWait = Date.parse(state.backoffUntil!) - before;
  expect(firstWait).toBeGreaterThanOrEqual(55_000);
  expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);

  await freshenRun();
  state = readFreshenState(derived);
  expect(state.failures).toBe(2);
  expect(Date.parse(state.backoffUntil!) - Date.now()).toBeGreaterThan(110_000);
  const rows = listMetrics(vault, { surface: INDEX_FRESHEN_SURFACE });
  expect(rows.map((r) => r.payload["outcome"])).toEqual(["failed", "failed"]);
});

test("a success after failures clears the streak and the backoff", async () => {
  mkdirSync(join(derived, "brain.sqlite"));
  await freshenRun();
  rmSync(join(derived, "brain.sqlite"), { recursive: true });
  await freshenRun();
  const state = readFreshenState(derived);
  expect(state.lastOutcome).toBe("completed");
  expect(state.failures).toBe(0);
  expect(state.backoffUntil).toBeNull();
});

test("a run that meets another index writer is a skip, not a failure", async () => {
  const release = acquireWriterLockSync(join(derived, "brain.sqlite"));
  try {
    await freshenRun();
  } finally {
    release();
  }
  const state = readFreshenState(derived);
  expect(state.failures).toBe(0);
  expect(state.backoffUntil).toBeNull();
  expect(state.lastOutcome).toBeNull();
  expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);
  expect(listMetrics(vault, { surface: INDEX_FRESHEN_SURFACE })).toHaveLength(0);
});

test("a run that fails before it can resolve its config still records the failure and releases the claim", async () => {
  const token = claimFreshen(derived, Date.now())!;
  const result = await runCli(
    [
      "search",
      "index",
      "--config",
      join(tmp, "missing.yaml"),
      "--freshen",
      token,
      "--freshen-state",
      derived,
    ],
    { env: env() },
  );
  expect(result.returncode).not.toBe(0);
  const state = readFreshenState(derived);
  expect(state.lastOutcome).toBe("failed");
  expect(state.failures).toBe(1);
  expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);
});

test("a run that cannot pass leaves a queued marker for the next run", async () => {
  // The child that cannot run a pass (a config that never resolves)
  // must leave the marker exactly as it stands: a settle that ran
  // anyway would clear markers at or before the child's scan start -
  // instants no pass of this child ever scanned past - and the queued
  // write would lose its second pass. The marker names an instant
  // BEFORE the scan start on purpose: that is the instant class the
  // settle's covered branch clears, and only a pass that ran can have
  // covered it.
  markFreshenPending(derived, Date.now() - 60_000);
  const token = claimFreshen(derived, Date.now())!;
  const result = await runCli(
    [
      "search",
      "index",
      "--config",
      join(tmp, "missing.yaml"),
      "--freshen",
      token,
      "--freshen-state",
      derived,
    ],
    { env: env() },
  );
  expect(result.returncode).not.toBe(0);
  expect(readFreshenPending(derived)).not.toBeNull();
  expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);
});

test("a run locked out of the index leaves a queued marker for the next run", async () => {
  // INDEX_LOCKED ends the child before any pass ran, so the same rule
  // holds: nothing this child scanned can cover the marker, and the
  // release still happens. The marker names an instant before the scan
  // start - the class the settle's covered branch clears.
  markFreshenPending(derived, Date.now() - 60_000);
  const release = acquireWriterLockSync(join(derived, "brain.sqlite"));
  try {
    const token = claimFreshen(derived, Date.now())!;
    const result = await runCli(
      ["search", "index", "--freshen", token, "--freshen-state", derived],
      { env: env() },
    );
    expect(result.returncode).toBe(0);
    expect(readFreshenPending(derived)).not.toBeNull();
    expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);
  } finally {
    release();
  }
});

test("a completed run clears a marker its scan covered and keeps one it cannot have seen", async () => {
  // Both halves of the settle over a real child run. A marker older
  // than the run's scan start is covered by the main pass and cleared;
  // an instant AFTER the scan start is not - neither the main pass nor
  // the bounded extra pass can prove it saw that write - so the marker
  // survives the run for the next one.
  markFreshenPending(derived, Date.now() - 60_000);
  const result = await freshenRun();
  expect(result.returncode).toBe(0);
  expect(readFreshenPending(derived)).toBeNull();

  markFreshenPending(derived, Date.now() + 60_000);
  const second = await freshenRun();
  expect(second.returncode).toBe(0);
  expect(readFreshenPending(derived)).not.toBeNull();
});
