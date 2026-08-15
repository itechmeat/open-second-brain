/**
 * The two things a long verb says about its own observation, written
 * once instead of once per verb (nothing-runs-unwatched, U1 + U3).
 *
 * Six verbs attach the progress rail, and the two whose operation yields
 * to the event loop also listen for an interrupt. Both facts they report -
 * "you asked to watch and the stream cannot carry it" and "the operator
 * stopped this run" - are single facts with a single wording, so they live
 * beside the mechanisms that produce them rather than being retyped at
 * each call site.
 *
 * The handles below name `reindex` because `onInterrupt` refuses any
 * operation that cannot observe a signal; the reporting arm under test is
 * the same one for every verb that reaches it.
 *
 * Neither is reachable through `o2b brain ...` or `o2b search ...`: both
 * families own their own JSON, so `main` never wraps them and the rail is
 * never refused there. That is precisely why these arms need a test of
 * their own - a copy per verb would be five untested branches, and the
 * refusal arm is what a SIXTH caller on a wrapped command would hit.
 */

import { describe, expect, test } from "bun:test";

import { EXIT_INTERRUPTED, onInterrupt, reportInterrupted } from "../../src/cli/interrupt.ts";
import {
  attachProgress,
  PROGRESS_OUTCOME,
  reportProgressRefusal,
} from "../../src/cli/progress-rail.ts";
import { PROGRESS_REASON } from "../../src/core/brain/progress.ts";
import { OPERATION, SafeguardAbortError } from "../../src/core/brain/safeguard.ts";

/** Run `body` with both output streams captured. */
function captured(body: () => void): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout, stderr };
}

describe("a refused rail", () => {
  test("is reported by name, not passed over in silence", () => {
    const written: string[] = [];
    // `cron-recipe` is wrapped by `withJsonFallback` under `--json`, which
    // accumulates BOTH streams for the whole run - so the rail refuses
    // rather than write a line nobody would see until the end.
    const attached = attachProgress({ command: "cron-recipe", argv: [], jsonRequested: true });
    expect(attached.outcome).toBe(PROGRESS_OUTCOME.suppressedBufferedStream);

    reportProgressRefusal(attached, (chunk) => written.push(chunk));
    const line = written.join("");
    expect(line).toContain(PROGRESS_REASON.streamBuffered);
    expect(line.endsWith("\n")).toBe(true);
  });

  test("says nothing when the rail attached, and nothing when nobody asked", () => {
    const written: string[] = [];
    const push = (chunk: string): void => {
      written.push(chunk);
    };
    reportProgressRefusal(
      attachProgress({ command: "brain", argv: ["bridges"], jsonRequested: true }, () => {}),
      push,
    );
    // `null` is the shape a verb holds when `--progress` was not passed.
    // There is no refusal to report, and inventing one would be noise.
    reportProgressRefusal(null, push);
    expect(written).toEqual([]);
  });

  test("is unreachable from the two families that emit progress, and that is the claim", () => {
    // `PROGRESS_OUTCOME.suppressedBufferedStream` documents itself as
    // having no shipped producer. That is a claim about these two
    // commands, so it is asserted rather than described: a verb outside
    // `brain`/`search` growing `--progress` makes the refusal reachable,
    // and the docblock that says otherwise must fail on the same day.
    for (const command of ["brain", "search"]) {
      for (const jsonRequested of [true, false]) {
        expect(attachProgress({ command, argv: [], jsonRequested }, () => {}).outcome).toBe(
          PROGRESS_OUTCOME.emitted,
        );
      }
    }
  });
});

describe("an interrupted run", () => {
  test("exits with the shell's signal convention rather than success", () => {
    const handle = onInterrupt(OPERATION.reindex);
    try {
      const out = captured(() =>
        expect(reportInterrupted(handle, new SafeguardAbortError("bridges"), false)).toBe(
          EXIT_INTERRUPTED,
        ),
      );
      expect(EXIT_INTERRUPTED).not.toBe(0);
      expect(out.stderr).toContain("bridges");
      // The human arm owns stderr only: a line on stdout would land in
      // the middle of the payload the verb had already begun writing.
      expect(out.stdout).toBe("");
    } finally {
      handle.release();
    }
  });

  test("hands a --json caller a parseable refusal instead of a bare stream", () => {
    const handle = onInterrupt(OPERATION.reindex);
    try {
      const out = captured(() => {
        reportInterrupted(handle, new SafeguardAbortError("clusters"), true);
      });
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, interrupted: true });
      expect(out.stderr).toBe("");
    } finally {
      handle.release();
    }
  });
});
