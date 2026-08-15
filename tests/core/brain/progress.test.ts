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
  withProgress,
  withProgressAsync,
  type ProgressEvent,
} from "../../../src/core/brain/progress.ts";
import {
  isOperation,
  OPERATION,
  OPERATIONS,
  SafeguardAbortError,
} from "../../../src/core/brain/safeguard.ts";

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

  test("a throwing sink with no reporter is contained, not fatal, and not silent", () => {
    // The default had to become the SAFE one. A reviewer found that with
    // the unsafe default - the throw propagating - one of six emitters
    // supplied a reporter and five did not, so a broken pipe aborted five
    // long operations and left the sixth running. A rule every caller
    // must remember is a rule five of six callers forget.
    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      let calls = 0;
      const counter = progressCounter(OPERATION.clusters, () => {
        calls += 1;
        throw new Error("stream closed");
      });
      expect(() => counter.start("sweep")).not.toThrow();
      expect(() => counter.advance("sweep")).not.toThrow();
      // Detached after one failure: one defect, one report.
      expect(calls).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("clusters");
      expect(lines[0]).toContain("stream closed");
    } finally {
      process.stderr.write = realWrite;
    }
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

describe("a run ends once", () => {
  test("a second terminator is a defect, not a second ending", () => {
    const counter = progressCounter(OPERATION.dream, () => {});
    counter.start("close");
    counter.finish();
    expect(() => counter.finish()).toThrow(/stream ended/);
    expect(() => counter.stop(PROGRESS_REASON.aborted)).toThrow(/stream ended/);
  });

  test("nothing may be emitted after the stream ended", () => {
    const counter = progressCounter(OPERATION.dream, () => {});
    counter.start("close");
    counter.stop(PROGRESS_REASON.aborted);
    expect(() => counter.advance("close")).toThrow(/stream ended/);
    expect(() => counter.start("reconcile")).toThrow(/stream ended/);
  });

  test("the counter only moves forward", () => {
    // A stream whose counter can go backwards, or sit still while
    // claiming to advance, describes a run nobody could follow.
    const counter = progressCounter(OPERATION.dream, () => {});
    counter.start("close");
    expect(() => counter.advance("close", 0)).toThrow(/positive integer/);
    expect(() => counter.advance("close", -3)).toThrow(/positive integer/);
    expect(() => counter.advance("close", 1.5)).toThrow(/positive integer/);
  });
});

describe("withProgress keeps its own promise", () => {
  test("a normal return terminates the stream", () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.bridges, (e) => seen.push(e));
    counter.start("candidates");
    expect(withProgress(counter, () => 42)).toBe(42);
    expect(seen.at(-1)?.kind).toBe(PROGRESS_KIND.finished);
  });

  test("a crash terminates the stream too, and says so", () => {
    // The docblock promises termination "whichever way it ends", and a
    // crash is a way a run ends. Without this the promise held only for
    // the two safeguard stops, and a crashed run's stream simply stopped
    // arriving - which is the shape of a hung run.
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.bridges, (e) => seen.push(e));
    counter.start("candidates");
    expect(() =>
      withProgress(counter, () => {
        throw new Error("store closed");
      }),
    ).toThrow("store closed");
    expect(seen.at(-1)).toMatchObject({
      kind: PROGRESS_KIND.stopped,
      reason: PROGRESS_REASON.failed,
    });
  });

  test("a safeguard stop keeps its own reason rather than reading as a crash", () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.dream, (e) => seen.push(e));
    counter.start("close");
    expect(() =>
      withProgress(counter, () => {
        throw new SafeguardAbortError("dream");
      }),
    ).toThrow(SafeguardAbortError);
    expect(seen.at(-1)?.reason).toBe(PROGRESS_REASON.aborted);
  });

  test("the async form behaves identically", async () => {
    const seen: ProgressEvent[] = [];
    const counter = progressCounter(OPERATION.reindex, (e) => seen.push(e));
    counter.start("walk");
    await expect(withProgressAsync(counter, () => Promise.reject(new Error("io")))).rejects.toThrow(
      "io",
    );
    expect(seen.at(-1)).toMatchObject({
      kind: PROGRESS_KIND.stopped,
      reason: PROGRESS_REASON.failed,
    });
  });
});
