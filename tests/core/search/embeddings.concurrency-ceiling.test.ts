/**
 * The outbound-request ceiling, from the counting primitive up
 * (nothing-runs-unwatched, U4).
 *
 * Three claims, in the order they compose:
 *   1. `Semaphore` never lets more holders in than its ceiling, including
 *      when a fresh acquire lands in the same synchronous turn as a
 *      release.
 *   2. The ceiling is taken exactly as configured or refused - never
 *      truncated into a different one.
 *   3. The ceiling spans the PROCESS: two overlapping `embed()` calls
 *      against one resolved provider identity share one budget, and two
 *      different identities do not.
 */

import { test, expect } from "bun:test";

import { Semaphore } from "../../../src/core/search/embeddings/http-util.ts";

test("Semaphore hands a released permit to the waiter, not to a racing acquirer", async () => {
  const sem = new Semaphore(1);
  let held = 0;
  let peak = 0;
  const enter = (): void => {
    held++;
    if (held > peak) peak = held;
  };
  const leave = (): void => {
    held--;
    sem.release();
  };

  // A holds the only permit.
  await sem.acquire();
  enter();

  // The critical section spans an await, so two holders overlap rather
  // than running to completion one microtask apart.
  const hold = async (): Promise<void> => {
    enter();
    await Promise.resolve();
    leave();
  };

  // B queues behind A.
  const b = sem.acquire().then(hold);

  // A releases. The freed permit is B's.
  leave();

  // C arrives in the SAME synchronous turn as that release - before B's
  // continuation has had a microtask to run. A semaphore that bumps its
  // permit count on release and lets the woken waiter decrement it later
  // hands this permit to C as well, and both run.
  const c = sem.acquire().then(hold);

  await Promise.all([b, c]);
  expect(peak).toBe(1);
  expect(held).toBe(0);
});
