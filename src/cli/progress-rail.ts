/**
 * The progress emission rail (nothing-runs-unwatched, U1).
 *
 * Twin of `advisory-rail.ts`, and deliberately built the same way: one
 * module owns what reaches the stream, so the rule cannot drift verb by
 * verb. It answers the same two questions that rail does, about a
 * different stream.
 *
 *   1. WHAT to write. A `ProgressEvent` carries an operation identifier, a
 *      stage identifier and integers. There is no parameter through which
 *      a caller can supply a sentence: the human line is rendered here,
 *      from the identifiers, exactly as the advisory rail refuses prose.
 *   2. WHETHER it is legal to write it. Progress goes to **stderr**,
 *      never stdout - every intermediate-output precedent in this CLI is
 *      on stderr, and twelve top-level commands own their stdout as a
 *      payload a caller parses. But stderr is not unconditionally safe:
 *      `withJsonFallback` monkey-patches stdout AND stderr into string
 *      accumulators for the whole run and releases one envelope at the
 *      end. A progress line there is not degraded, it is invisible until
 *      the run finishes and then dumped at once - which reads as though
 *      it had worked. So the rail refuses, by name, rather than writing
 *      into a buffer.
 *
 * That second reason is the one thing here that is not obvious from the
 * code it guards, and it rests on a fact about a different module. The
 * fact is asserted in `tests/cli/progress-rail.test.ts` rather than
 * trusted: if `withJsonFallback` ever stops patching stderr, the test
 * says so instead of this comment quietly becoming false.
 */

import {
  PROGRESS_REASON,
  isProgressKind,
  type ProgressEvent,
  type ProgressSink,
} from "../core/brain/progress.ts";

import { ownsInternalJson } from "./json-helpers.ts";

/** The stream an emission is being considered for. */
export interface ProgressStream {
  /** Top-level `o2b` command, e.g. `brain`. */
  readonly command: string;
  /** Argv tail after the top-level command, as `main` dispatched it. */
  readonly argv: ReadonlyArray<string>;
  /**
   * Whether the caller asked for JSON, read from the verb's PARSED flags.
   * Never a raw-argv scan - a positional whose text happens to contain
   * the flag would otherwise silence a legitimate stream.
   */
  readonly jsonRequested: boolean;
}

/** Why an emission did or did not reach stderr. Every case is named. */
export const PROGRESS_OUTCOME = Object.freeze({
  /** Lines were written to stderr as the operation ran. */
  emitted: "emitted",
  /**
   * The command's streams are buffered for the whole run, so a line would
   * surface only at the end. Refused rather than written into the buffer.
   */
  suppressedBufferedStream: "suppressed-buffered-stream",
} as const);

export type ProgressOutcome = (typeof PROGRESS_OUTCOME)[keyof typeof PROGRESS_OUTCOME];

/** Membership list for {@link isProgressOutcome}. */
export const PROGRESS_OUTCOMES: ReadonlyArray<ProgressOutcome> = Object.freeze([
  PROGRESS_OUTCOME.emitted,
  PROGRESS_OUTCOME.suppressedBufferedStream,
]);

/** Whether `value` is an outcome this build understands. */
export function isProgressOutcome(value: unknown): value is ProgressOutcome {
  return typeof value === "string" && (PROGRESS_OUTCOMES as ReadonlyArray<string>).includes(value);
}

/**
 * True when progress may be written for `stream`.
 *
 * Under `--json` this is the exact INVERSE of `advisoryIsLegal`, and the
 * inversion is not an accident to be tidied away. One wrapper decides
 * both. Where it is installed it accumulates stdout, which makes an
 * advisory line harmless - and it accumulates stderr, which makes a
 * progress line worthless, because progress is only worth anything while
 * the operation is still running. So the same buffering that legalises
 * one surface disqualifies the other. `progress-rail.test.ts` pins the
 * relation, so a reader who notices the two predicates disagree finds the
 * reason asserted rather than has to guess which one is backwards.
 */
export function progressIsLegal(stream: ProgressStream): boolean {
  if (!stream.jsonRequested) return true;
  return ownsInternalJson(stream.command, stream.argv);
}

/**
 * One newline-delimited JSON record per event.
 *
 * NDJSON rather than a human sentence because the caller this exists for
 * is an adapter or a script tailing stderr, and because a partial line is
 * self-evidently partial. The event is written as it stands: it already
 * carries its own schema discriminator, so a reader can tell a progress
 * line from any other stderr traffic without parsing prose.
 */
export function renderProgressLine(event: ProgressEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** What one rail attachment decided, in full. */
export interface ProgressAttachment {
  readonly outcome: ProgressOutcome;
  /**
   * The sink to hand to the operation, or `undefined` when the rail
   * refused. Undefined is the house idiom for "nobody asked" - passing a
   * sink that discards would make a refusal indistinguishable from a run
   * that produced no events.
   */
  readonly sink: ProgressSink | undefined;
  /**
   * Present only on a refusal, naming why. A caller rendering a `--json`
   * payload carries it as a field, so the refusal is visible on the
   * surface the caller actually reads.
   */
  readonly reason?: typeof PROGRESS_REASON.streamBuffered;
}

/**
 * Decide whether to observe `stream`, and return the sink if so.
 *
 * `write` is injectable so a test can read what would reach the terminal
 * without the terminal; production callers omit it.
 */
export function attachProgress(
  stream: ProgressStream,
  write: (chunk: string) => void = (chunk) => {
    process.stderr.write(chunk);
  },
): ProgressAttachment {
  if (!progressIsLegal(stream)) {
    return Object.freeze({
      outcome: PROGRESS_OUTCOME.suppressedBufferedStream,
      sink: undefined,
      reason: PROGRESS_REASON.streamBuffered,
    });
  }
  const sink: ProgressSink = (event) => {
    // A kind this build does not know cannot be rendered honestly, and
    // silently dropping it would hide a version skew between a core that
    // emits and an edge that renders. It cannot arrive from outside - the
    // producer is in this process - so it is a defect, not input.
    if (!isProgressKind(event.kind)) {
      throw new TypeError(`progress: unknown event kind ${JSON.stringify(event.kind)}`);
    }
    write(renderProgressLine(event));
  };
  return Object.freeze({ outcome: PROGRESS_OUTCOME.emitted, sink });
}
