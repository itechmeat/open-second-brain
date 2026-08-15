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
   *
   * NO SHIPPED COMMAND REACHES THIS TODAY, and the reason is worth being
   * exact about rather than leaving a reader to discover by grep. The
   * refusal is reached when a caller asks for JSON on a command `main`
   * WRAPS in `withJsonFallback`. Both families that emit progress -
   * `brain` and `search` - own their own JSON, so `ownsInternalJson` is
   * true for them and `progressIsLegal` returns true unconditionally.
   * Every production `attachProgress` call site is in one of those two.
   *
   * So this is not a stub waiting for a producer: it is the decision the
   * rail must make, currently made the same way every time because the
   * population asking is currently uniform. Deleting the branch would not
   * remove a dead path, it would remove the check - and the first verb on
   * a wrapped command to take `--progress` would then write its stream
   * into an accumulator that releases at the end, which reads as though
   * it had worked. `progress-report.test.ts` drives the branch directly
   * and pins the reachability claim above, so the day that verb exists
   * the claim fails instead of quietly going stale.
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
   * Present only on a refusal, naming why.
   *
   * Read by {@link reportProgressRefusal} and by nothing else. An earlier
   * docblock here claimed a `--json` verb carries it as a payload field;
   * none does, and none can today, because a refusal only happens on a
   * command whose JSON is wrapped rather than rendered by the verb. The
   * refusal reaches the operator on stderr, which is where it belongs and
   * where the wording is written once.
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

/**
 * Tell the caller its request for progress was declined, and why.
 *
 * A refusal that produced no line would be indistinguishable from an
 * operation that simply had nothing to report - the caller would watch a
 * silent stream and conclude the run had hung. So the reason is named on
 * stderr, in the one wording every verb shares.
 *
 * Written BEFORE the operation starts rather than after it. A caller told
 * at the end that nobody was watching learns it too late to do anything
 * with; worse, an operation that is then interrupted or fails never
 * reaches its own epilogue at all, so a refusal reported there would go
 * missing exactly when the caller most needed to know why the stream was
 * empty.
 *
 * `null` is the shape a verb holds when nobody asked for progress at all,
 * and it is silent by construction: `reason` is set only on a refusal, so
 * there is a fact to report or there is not.
 */
export function reportProgressRefusal(
  attachment: ProgressAttachment | null,
  write: (chunk: string) => void = (chunk) => {
    process.stderr.write(chunk);
  },
): void {
  if (attachment === null || attachment.reason === undefined) return;
  write(`progress: not emitted (${attachment.reason})\n`);
}
