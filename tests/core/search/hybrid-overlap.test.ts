/**
 * The overlapped-lane join seam (recall-lane-latency): the semantic lane
 * starts before the keyword lanes run and is joined where the serial await
 * stood. These are the seam's own unit tests, over fake promises, so the
 * catch-attachment semantics are pinned without an HTTP round trip: the
 * lane starts at seam-creation time (the keyword step's window), a
 * keyword-step throw never strands an in-flight lane as an unhandled
 * rejection, and a clock that already ran out starts nothing.
 */

import { expect, test } from "bun:test";

import { createCompositeDeadline, startSemanticLane } from "../../../src/core/search/search.ts";

/**
 * A real composite deadline with a controlled clock: `expiresAt` is what
 * the seam reads, so the budget is anchored backwards from it.
 */
function realDeadline(expiresAt: number): {
  readonly deadline: NonNullable<ReturnType<typeof createCompositeDeadline>>;
  readonly warnings: string[];
} {
  const warnings: string[] = [];
  const budgetMs = 60_000;
  const deadline = createCompositeDeadline({
    budgetMs,
    startMs: expiresAt - budgetMs,
    warnings,
    degraded: [],
    wantSemantic: true,
    keywordHitCount: () => 1,
  });
  if (deadline === null) throw new Error("a named budget must build a deadline");
  return { deadline, warnings };
}

test("the lane starts when the seam is created, so the keyword step runs while it is pending", async () => {
  const gate = Promise.withResolvers<string>();
  let settled = false;
  const lane = startSemanticLane({
    start: () =>
      gate.promise.then((value) => {
        settled = true;
        return value;
      }),
    deadline: null,
    fallback: () => {
      throw new Error("the fallback must never run for a joined lane");
    },
  });
  // The caller's synchronous keyword step runs HERE, between start and
  // join, while the lane promise is still in flight.
  expect(settled).toBe(false);
  gate.resolve("lane outcome");
  expect(await lane.join()).toBe("lane outcome");
});

test("a keyword-step throw with a deadline routes the lane's rejection to the abandoned-failure note", async () => {
  const gate = Promise.withResolvers<string>();
  const { deadline, warnings } = realDeadline(Date.now() + 60_000);
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  // The keyword step throws and the call unwinds without ever joining;
  // the in-flight lane rejects afterwards.
  const keywordStep = (): never => {
    throw new Error("keyword lane exploded");
  };
  expect(() => keywordStep()).toThrow("keyword lane exploded");
  // The joiner exists even though this caller never reaches its join.
  expect(typeof lane.join).toBe("function");
  gate.reject(new Error("embed exploded"));
  await Bun.sleep(10);
  expect(
    warnings.some((w) =>
      w.startsWith(
        "hybrid deadline: an abandoned lane failed after the answer: Error: embed exploded",
      ),
    ),
  ).toBe(true);
});

test("a keyword-step throw with no deadline leaves no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = Promise.withResolvers<string>();
    const lane = startSemanticLane({
      start: () => gate.promise,
      deadline: null,
      fallback: () => "fallback",
    });
    const keywordStep = (): never => {
      throw new Error("keyword lane exploded");
    };
    expect(() => keywordStep()).toThrow("keyword lane exploded");
    // The joiner exists even though this caller never reaches its join.
    expect(typeof lane.join).toBe("function");
    gate.reject(new Error("embed exploded"));
    await Bun.sleep(20);
    // Nobody joined; the seam owns the stranded lane and its rejection.
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an already-expired deadline starts nothing and serves the fallback", async () => {
  let started = false;
  const { deadline, warnings } = realDeadline(Date.now() - 1);
  const lane = startSemanticLane({
    start: () => {
      started = true;
      return Promise.resolve("lane");
    },
    deadline,
    fallback: () => "fallback",
  });
  expect(started).toBe(false);
  expect(warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
  expect(await lane.join()).toBe("fallback");
});

test("a joined lane that loses the race serves the fallback and names a late failure", async () => {
  const gate = Promise.withResolvers<string>();
  const { deadline, warnings } = realDeadline(Date.now() + 25);
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  expect(await lane.join()).toBe("fallback");
  expect(warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
  gate.reject(new Error("late embed failure"));
  await Bun.sleep(20);
  expect(
    warnings.some((w) =>
      w.startsWith(
        "hybrid deadline: an abandoned lane failed after the answer: Error: late embed failure",
      ),
    ),
  ).toBe(true);
});

test("a lane that rejects before the fire rethrows through the join", async () => {
  const gate = Promise.withResolvers<string>();
  const { deadline } = realDeadline(Date.now() + 60_000);
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  gate.reject(new Error("embed refused"));
  const note = await lane.join().then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );
  expect(note).toBe("embed refused");
});
