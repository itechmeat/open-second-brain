import { describe, expect, test } from "bun:test";

import {
  isProgressKind,
  isProgressReason,
  PROGRESS_KIND,
  PROGRESS_KINDS,
  PROGRESS_REASON,
  PROGRESS_REASONS,
  PROGRESS_SCHEMA,
  progressCounter,
  type ProgressEvent,
} from "../../../src/core/brain/progress.ts";
import { OPERATION, OPERATIONS, isOperation } from "../../../src/core/brain/safeguard.ts";

describe("progress vocabulary", () => {
  test("kinds are frozen, complete, and guarded", () => {
    expect(Object.isFrozen(PROGRESS_KIND)).toBe(true);
    expect(PROGRESS_KINDS.toSorted()).toEqual(Object.values(PROGRESS_KIND).toSorted());
    for (const kind of PROGRESS_KINDS) expect(isProgressKind(kind)).toBe(true);
  });

  test("the guard refuses plausible drift, not only obvious garbage", () => {
    for (const outsider of ["", " ", "Started", "start", "advance", null, undefined, 7, {}]) {
      expect(isProgressKind(outsider)).toBe(false);
    }
  });

  test("reasons are frozen, complete, and guarded", () => {
    expect(Object.isFrozen(PROGRESS_REASON)).toBe(true);
    expect(PROGRESS_REASONS.toSorted()).toEqual(Object.values(PROGRESS_REASON).toSorted());
    for (const reason of PROGRESS_REASONS) expect(isProgressReason(reason)).toBe(true);
    expect(isProgressReason("aborted ")).toBe(false);
  });

  test("the operation vocabulary the safeguard already owned is now guarded", () => {
    expect(Object.isFrozen(OPERATION)).toBe(true);
    expect(OPERATIONS.toSorted()).toEqual(Object.values(OPERATION).toSorted());
    for (const operation of OPERATIONS) expect(isOperation(operation)).toBe(true);
    expect(isOperation("Dream")).toBe(false);
    expect(isOperation(undefined)).toBe(false);
  });
});

describe("progressCounter", () => {
  test("emits started once, advances monotonically, and finishes once", () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.dream, (e) => seen.push(e));

    counter.start("close");
    counter.advance("close");
    counter.advance("close");
    counter.start("reconcile", 4);
    counter.advance("reconcile");
    counter.finish();

    expect(seen.map((e) => `${e.kind}:${e.stage}:${e.completed}`)).toEqual([
      "started:close:0",
      "advanced:close:1",
      "advanced:close:2",
      "started:reconcile:0",
      "advanced:reconcile:1",
      "finished:reconcile:1",
    ]);
    expect(seen.every((e) => e.operation === OPERATION.dream)).toBe(true);
    expect(seen.every((e) => e.schema === PROGRESS_SCHEMA)).toBe(true);
  });

  test("a stage with no denominator omits total rather than inventing one", () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.reindex, (e) => seen.push(e));
    counter.start("walk");
    counter.advance("walk");
    expect(seen.every((e) => e.total === undefined)).toBe(true);
    expect(Object.hasOwn(seen[1] as object, "total")).toBe(false);
  });

  test("a stage with a denominator carries it on every event of that stage", () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.reindex, (e) => seen.push(e));
    counter.start("embed", 12);
    counter.advance("embed", 4);
    expect(seen.map((e) => e.total)).toEqual([12, 12]);
    expect(seen.map((e) => e.completed)).toEqual([0, 4]);
  });

  test("a total that is not a non-negative integer is refused loudly", () => {
    const counter = progressCounter(OPERATION.dream, () => {});
    expect(() => counter.start("close", -1)).toThrow(/total/);
    expect(() => counter.start("close", 1.5)).toThrow(/total/);
  });

  test("advancing before any stage started is refused rather than silently ignored", () => {
    const counter = progressCounter(OPERATION.dream, () => {});
    expect(() => counter.advance("close")).toThrow(/stage/);
  });

  test("stopped carries a reason from the closed vocabulary", () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.dream, (e) => seen.push(e));
    counter.start("close");
    counter.stop(PROGRESS_REASON.aborted);
    expect(seen.at(-1)).toMatchObject({
      kind: PROGRESS_KIND.stopped,
      reason: PROGRESS_REASON.aborted,
    });
  });

  test("no sink attached is the absence of an observer, not a swallowed event", () => {
    // The house idiom is `opts.onProgress?.(...)`: absence means nobody
    // asked. A counter built with no sink must therefore be constructible
    // and inert, and must still refuse invalid input - a silent counter
    // that also silently accepted a bad total would hide the defect.
    const counter = progressCounter(OPERATION.dream, undefined);
    expect(() => counter.start("close")).not.toThrow();
    expect(() => counter.start("close", -3)).toThrow(/total/);
  });

  test("a sink that throws does not take the operation down with it", () => {
    // Progress is observation. An edge renderer with a broken stream must
    // not abort a consolidation pass that is otherwise succeeding, and the
    // failure must not be silent either - it is re-reported once, to the
    // reporter the caller supplied.
    const failures: unknown[] = [];
    const counter = progressCounter(
      OPERATION.dream,
      () => {
        throw new Error("stream closed");
      },
      { onSinkError: (e) => failures.push(e) },
    );
    expect(() => counter.start("close")).not.toThrow();
    expect(failures).toHaveLength(1);
  });
});
