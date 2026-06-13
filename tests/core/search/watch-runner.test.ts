/**
 * IndexWatchRunner (Indexer Durability suite, t_ea80ddb5): the testable
 * core of `o2b search watch`'s flush + shutdown coordination. Single-
 * flight flushes; a shutdown aborts the in-flight pass and awaits it to
 * settle at a cooperative boundary, bounded by a grace window, so a
 * SIGTERM never kills a run mid-write. Clock-free and signal-free here -
 * the CLI wires fs.watch and the OS signals to it.
 */

import { expect, test } from "bun:test";

import { IndexWatchRunner } from "../../../src/core/search/watch-runner.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("shutdown awaits an in-flight flush to completion within the grace window", async () => {
  let done = false;
  const runner = new IndexWatchRunner({
    graceMs: 5_000,
    index: async () => {
      await delay(5);
      done = true;
    },
  });
  void runner.flush();
  await runner.shutdown();
  expect(done).toBe(true);
  expect(runner.isStopped).toBe(true);
});

test("shutdown aborts the in-flight pass at its cooperative boundary", async () => {
  let abortedSeen = false;
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner = new IndexWatchRunner({
    graceMs: 5_000,
    index: async (signal) => {
      signal.addEventListener("abort", () => {
        abortedSeen = true;
        release();
      });
      await gate;
    },
  });
  void runner.flush();
  await Promise.resolve();
  await runner.shutdown();
  expect(abortedSeen).toBe(true);
});

test("a flush requested after shutdown is refused", async () => {
  let calls = 0;
  const runner = new IndexWatchRunner({
    graceMs: 0,
    index: async () => {
      calls++;
    },
  });
  await runner.shutdown();
  await runner.flush();
  expect(calls).toBe(0);
  expect(runner.isStopped).toBe(true);
});

test("a flush that outlasts the grace window still lets shutdown return", async () => {
  let waited = -1;
  const runner = new IndexWatchRunner({
    graceMs: 5_000,
    index: () => new Promise<void>(() => {}), // never resolves
    graceWaiter: (ms) => {
      waited = ms;
      return Promise.resolve();
    },
  });
  void runner.flush();
  await Promise.resolve();
  await runner.shutdown();
  expect(waited).toBe(5_000);
  // The pass is still pending; shutdown returned via the grace waiter.
  expect(runner.isFlushing).toBe(true);
});

test("concurrent flush calls coalesce into a single pass", async () => {
  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner = new IndexWatchRunner({
    graceMs: 0,
    index: async () => {
      calls++;
      await gate;
    },
  });
  const a = runner.flush();
  const b = runner.flush();
  expect(runner.isFlushing).toBe(true);
  release();
  await Promise.all([a, b]);
  expect(calls).toBe(1);
});
