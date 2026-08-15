/**
 * The progress rail, and the fact it rests on.
 *
 * The rail refuses to write progress for a command whose streams are
 * buffered for the whole run, because a line there would be invisible
 * until completion and then dumped at once - which reads as though it had
 * worked. That refusal is only correct while `withJsonFallback` really
 * does patch stderr as well as stdout. The last test asserts it, so the
 * rail's reasoning cannot quietly become false.
 */

import { describe, expect, test } from "bun:test";

import {
  attachProgress,
  isProgressOutcome,
  PROGRESS_OUTCOME,
  PROGRESS_OUTCOMES,
  progressIsLegal,
  renderProgressLine,
} from "../../src/cli/progress-rail.ts";
import { advisoryIsLegal } from "../../src/cli/advisory-rail.ts";
import { COMMANDS_WITH_INTERNAL_JSON, withJsonFallback } from "../../src/cli/json-helpers.ts";
import { PROGRESS_KIND, PROGRESS_REASON, PROGRESS_SCHEMA } from "../../src/core/brain/progress.ts";
import { OPERATION } from "../../src/core/brain/safeguard.ts";

const EVENT = Object.freeze({
  schema: PROGRESS_SCHEMA,
  operation: OPERATION.dream,
  kind: PROGRESS_KIND.advanced,
  stage: "scan",
  completed: 3,
} as const);

describe("progress legality", () => {
  test("a human run is always observable", () => {
    expect(progressIsLegal({ command: "brain", argv: ["dream"], jsonRequested: false })).toBe(true);
    expect(progressIsLegal({ command: "vault", argv: ["map"], jsonRequested: false })).toBe(true);
  });

  test("a JSON run of a command that owns its own JSON is observable", () => {
    // `brain` and `search` render their own payloads, so `main` never
    // wraps them and stderr flows straight through. Both long-operation
    // families live there, which is what makes the rail useful at all.
    expect(COMMANDS_WITH_INTERNAL_JSON.has("brain")).toBe(true);
    expect(COMMANDS_WITH_INTERNAL_JSON.has("search")).toBe(true);
    expect(progressIsLegal({ command: "brain", argv: ["dream"], jsonRequested: true })).toBe(true);
  });

  test("a JSON run of a wrapped command is refused, not buffered", () => {
    const attached = attachProgress({
      command: "cron-recipe",
      argv: [],
      jsonRequested: true,
    });
    expect(attached.outcome).toBe(PROGRESS_OUTCOME.suppressedBufferedStream);
    expect(attached.sink).toBeUndefined();
    expect(attached.reason).toBe(PROGRESS_REASON.streamBuffered);
  });

  test("the outcome vocabulary is complete and guarded", () => {
    expect(PROGRESS_OUTCOMES.toSorted()).toEqual(Object.values(PROGRESS_OUTCOME).toSorted());
    for (const outcome of PROGRESS_OUTCOMES) expect(isProgressOutcome(outcome)).toBe(true);
    expect(isProgressOutcome("emitted ")).toBe(false);
  });
});

describe("progress rendering", () => {
  test("one newline-delimited record per event, schema included", () => {
    const line = renderProgressLine(EVENT);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({ ...EVENT });
  });

  test("the sink writes exactly the rendered line", () => {
    const written: string[] = [];
    const attached = attachProgress(
      { command: "brain", argv: ["dream"], jsonRequested: false },
      (chunk) => written.push(chunk),
    );
    attached.sink?.(EVENT);
    expect(written).toEqual([renderProgressLine(EVENT)]);
  });

  test("an event kind this build does not know is a defect, not a dropped line", () => {
    const attached = attachProgress({ command: "brain", argv: ["dream"], jsonRequested: false });
    expect(() => attached.sink?.({ ...EVENT, kind: "flying" as never })).toThrow(/unknown event/);
  });
});

describe("the fact the refusal rests on", () => {
  test("withJsonFallback buffers stderr, not only stdout", async () => {
    // If this ever stops holding, the rail's refusal becomes needlessly
    // strict and its docblock becomes wrong. Asserting it here is what
    // keeps the reasoning honest rather than historical.
    const seen: string[] = [];
    const realStderr = process.stderr.write.bind(process.stderr);
    const realStdout = process.stdout.write.bind(process.stdout);
    try {
      await withJsonFallback("cron-recipe", async () => {
        process.stderr.write("during-the-run\n");
        // Captured, not printed: the accumulator is installed by the
        // wrapper, so this write does not reach the real stream.
        seen.push(process.stderr.write === realStderr ? "unpatched" : "patched");
        return 0;
      });
    } finally {
      process.stderr.write = realStderr;
      process.stdout.write = realStdout;
    }
    expect(seen).toEqual(["patched"]);
  });

  test("under --json the two rails are opposites, and that is the point", () => {
    // One wrapper decides both, in opposite directions. Where it is
    // installed, stdout is accumulated - which makes an advisory line
    // harmless and a progress line worthless, because progress is only
    // worth anything while the operation is still running. So the same
    // buffering that legalises one surface disqualifies the other, and a
    // reader comparing the two rails should see that rather than assume
    // one of them has the predicate backwards.
    for (const command of ["brain", "search", "cron-recipe", "vault", "explorer"]) {
      const stream = { command, argv: [] as ReadonlyArray<string>, jsonRequested: true };
      expect(progressIsLegal(stream)).toBe(!advisoryIsLegal(stream));
    }
    // Without --json neither wrapper nor payload exists, so both allow.
    for (const command of ["brain", "cron-recipe"]) {
      const stream = { command, argv: [] as ReadonlyArray<string>, jsonRequested: false };
      expect(progressIsLegal(stream)).toBe(true);
      expect(advisoryIsLegal(stream)).toBe(true);
    }
  });
});
