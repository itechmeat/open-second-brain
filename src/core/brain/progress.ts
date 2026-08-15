/**
 * The progress spine: what a long operation says while it is still
 * running (nothing-runs-unwatched, unit U1).
 *
 * Every operation this repository already calls long - the ones named by
 * {@link OPERATION} - accepts a `Safeguard` and calls `checkpoint()` at
 * its natural iteration boundaries. Those checkpoints are exactly the
 * boundaries a progress tick belongs at, and until this module none of
 * them emitted one: `o2b brain dream` printed its first character after
 * it had finished, and an agent driving a consolidation pass could not
 * tell a slow run from a hung one.
 *
 * The shape follows the house idiom rather than inventing one. A sink is
 * an OPTIONAL readonly field on the same options interface that already
 * carries `safeguard`, invoked with `?.`, exactly as `onFile`,
 * `onTelemetry`, `onOversize` and `validate` already are. Absence means
 * nobody asked - it is not a swallowed event.
 *
 * Three constraints the shape had to satisfy, all of them from the code
 * rather than from taste:
 *
 *   - **The sink is synchronous.** `dream`, `discoverBridges`,
 *     `detectCommunities` and `runDoctor` are synchronous functions; an
 *     `async` sink could not be awaited inside them, and Bun runs SQLite
 *     synchronously anyway. `(event) => void` matches `onFile` and
 *     `Safeguard.checkpoint`.
 *   - **`total` is optional and its absence means something.** The index
 *     driver consumes a generator, so the file count is not known before
 *     the walk; materialising it costs a second full traversal. The
 *     embedding phase, by contrast, holds an array and knows its
 *     denominator exactly. One event shape carries both, and a renderer
 *     that sees no `total` must show a bare counter rather than invent a
 *     percentage.
 *   - **No prose.** `stage` is an identifier drawn from the emitting
 *     operation's own phase vocabulary, never a sentence. The sentence is
 *     rendered at the edge from the identifier, which is the same rule
 *     that keeps caller-supplied prose off the advisory rail.
 *     `progress-census.test.ts` enforces the identifier shape over every
 *     emission site rather than leaving it to this comment.
 *
 * Core only emits. `tests/core/layering.test.ts` bans stdout writes here,
 * which is why the channel exists at all: the edge decides whether it can
 * carry an event, and one edge - the single-response HTTP MCP transport -
 * honestly cannot, which is what {@link PROGRESS_REASON.transportSingleResponse}
 * is for.
 */

import {
  OPERATION,
  SafeguardAbortError,
  SafeguardTimeoutError,
  type Operation,
} from "./safeguard.ts";

/** Envelope discriminator, so a reader can tell which shape it holds. */
export const PROGRESS_SCHEMA = "o2b.progress.v1";

/**
 * What one progress event says happened. `refused` and `stopped` are
 * first-class arms rather than shades of silence: an operation that was
 * never observed because the transport could not carry the events, and
 * one the operator cancelled, are different facts, and reporting either
 * as an absence of progress would be the misleading quiet this module
 * exists to remove.
 */
export const PROGRESS_KIND = Object.freeze({
  started: "started",
  advanced: "advanced",
  refused: "refused",
  stopped: "stopped",
  finished: "finished",
} as const);

export type ProgressKind = (typeof PROGRESS_KIND)[keyof typeof PROGRESS_KIND];

/** Membership list for {@link isProgressKind}. */
export const PROGRESS_KINDS: ReadonlyArray<ProgressKind> = Object.freeze([
  PROGRESS_KIND.started,
  PROGRESS_KIND.advanced,
  PROGRESS_KIND.refused,
  PROGRESS_KIND.stopped,
  PROGRESS_KIND.finished,
]);

/**
 * Whether `value` is a kind this build understands. Takes `unknown`
 * because the value arrives from a JSON line a caller parsed, or from a
 * notification a different release wrote.
 */
export function isProgressKind(value: unknown): value is ProgressKind {
  return typeof value === "string" && (PROGRESS_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Why an operation stopped short, or why its progress could not be
 * carried. A closed set for the same reason `stage` is an identifier:
 * a reader must be able to branch on it, and a free string would let
 * prose in through the back door.
 */
export const PROGRESS_REASON = Object.freeze({
  /** The operator cancelled; the pass stopped at a checkpoint. */
  aborted: "aborted",
  /** The cooperative deadline elapsed; the pass stopped at a checkpoint. */
  timedOut: "timed-out",
  /**
   * A progress token was supplied over a transport that writes one
   * response and closes, so no notification could be sent. Reported
   * rather than dropped: accepting a token and discarding the events
   * would advertise liveness support that does not exist.
   */
  transportSingleResponse: "transport-single-response",
  /**
   * The command's stdout and stderr are buffered for the whole run and
   * released at the end, so a progress line would be invisible until
   * completion and then dumped - which reads as though it had worked.
   */
  streamBuffered: "stream-buffered",
  /**
   * The operation threw. The stream ends here because the run did; the
   * error itself is the caller's to read, and naming it on the stream
   * would put an arbitrary message on a structured surface.
   *
   * This member exists because {@link withProgress} promises to
   * terminate the stream whichever way the run ends, and a crash is a way
   * a run ends. Without it the promise held only for the two safeguard
   * stops, and a crashed run's stream simply stopped arriving - which is
   * the shape of a hung run, and the exact confusion this module exists
   * to remove.
   */
  failed: "failed",
} as const);

export type ProgressReason = (typeof PROGRESS_REASON)[keyof typeof PROGRESS_REASON];

/** Membership list for {@link isProgressReason}. */
export const PROGRESS_REASONS: ReadonlyArray<ProgressReason> = Object.freeze([
  PROGRESS_REASON.aborted,
  PROGRESS_REASON.timedOut,
  PROGRESS_REASON.transportSingleResponse,
  PROGRESS_REASON.streamBuffered,
  PROGRESS_REASON.failed,
]);

/** Whether `value` is a reason this build understands. */
export function isProgressReason(value: unknown): value is ProgressReason {
  return typeof value === "string" && (PROGRESS_REASONS as ReadonlyArray<string>).includes(value);
}

/**
 * One tick. Integers and identifiers only - the sentence a human reads is
 * rendered from these at the edge.
 */
export interface ProgressEvent {
  readonly schema: typeof PROGRESS_SCHEMA;
  /** Which long operation is speaking. */
  readonly operation: Operation;
  readonly kind: ProgressKind;
  /**
   * An identifier from the emitting operation's own phase vocabulary
   * (`DREAM_PHASE`, the index phases, a lane task name). Never prose.
   */
  readonly stage: string;
  /** Units finished in this stage so far. Monotonic within a stage. */
  readonly completed: number;
  /**
   * The stage's denominator, when one is known BEFORE the loop starts.
   * Absent for a stage driven by a generator - see the module header.
   */
  readonly total?: number;
  /** Present on `stopped` and `refused`, absent otherwise. */
  readonly reason?: ProgressReason;
}

/** The observer a long operation calls. Synchronous by construction. */
export type ProgressSink = (event: ProgressEvent) => void;

/**
 * Emits progress for one run of one operation, keeping the per-stage
 * counter so no call site has to.
 *
 * Deliberately NOT a class: the repository's cross-cutting optional
 * observers are all plain functions or frozen objects, and a counter with
 * one live field does not earn a prototype.
 */
export interface ProgressCounter {
  /** Begin a stage. `total` is the denominator when one is known. */
  start(stage: string, total?: number): void;
  /** Advance the current stage by `by` units (default 1). */
  advance(stage: string, by?: number): void;
  /** The run ended normally. */
  finish(): void;
  /** The run ended early, for a named reason. */
  stop(reason: ProgressReason): void;
}

export interface ProgressCounterOptions {
  /**
   * Where a throwing sink is reported, when the caller has somewhere
   * better to put it than the default.
   *
   * Progress is observation, and an observation must not be able to
   * destroy the thing observed: a broken edge stream - a closed pipe, a
   * renderer defect - must not abort a consolidation pass that is
   * otherwise succeeding. Nor may it vanish, so the error is reported
   * **once** and the sink is then detached for the rest of the run.
   * Detaching is the point: a stream that failed on the first tick would
   * otherwise fail on every one, turning one defect into a flood.
   *
   * Supplying this is optional because the DEFAULT is already safe, and
   * that is deliberate. It was optional before with an unsafe default -
   * the throw propagated and took the pass down with it - and a reviewer
   * found the predictable result: one of six emitters supplied a reporter
   * and five did not, so a broken pipe aborted five long operations and
   * left the sixth running. A rule every caller must remember is a rule
   * five of six callers will forget, which is the argument this whole
   * release is built on. The safe behaviour is therefore the one you get
   * by writing nothing.
   */
  readonly onSinkError?: (error: unknown) => void;
}

/** One line of an unknown throw, without assuming it is an Error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Guards a denominator so a bad one is a loud defect, not a wrong number. */
function assertTotal(total: number | undefined): void {
  if (total === undefined) return;
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`progress: total must be a non-negative integer, got ${String(total)}`);
  }
}

export function progressCounter(
  operation: Operation,
  sink: ProgressSink | undefined,
  opts: ProgressCounterOptions = {},
): ProgressCounter {
  let stage: string | null = null;
  let completed = 0;
  let total: number | undefined;
  let live = sink !== undefined;
  let terminated = false;

  /**
   * A run ends once. A second terminator, or an event after one, would
   * let a reader see two endings for one run - which is worse than no
   * ending, because it looks well-formed.
   */
  const assertTerminal = (call: string, current: string | null): void => {
    if (!terminated) return;
    throw new RangeError(
      `progress: ${call}() after the ${operation} stream ended (last stage "${current ?? "none"}")`,
    );
  };

  const emit = (kind: ProgressKind, reason?: ProgressReason): void => {
    if (!live || sink === undefined || stage === null) return;
    const event: ProgressEvent = {
      schema: PROGRESS_SCHEMA,
      operation,
      kind,
      stage,
      completed,
      ...(total === undefined ? {} : { total }),
      ...(reason === undefined ? {} : { reason }),
    };
    try {
      sink(event);
    } catch (error) {
      live = false;
      if (opts.onSinkError !== undefined) {
        opts.onSinkError(error);
        return;
      }
      // The default report. Core may not write to stdout - the layering
      // test enforces it - but a fail-soft diagnostic on stderr is the
      // house convention, and stderr is never a protocol channel here:
      // the MCP server speaks on stdout. One line, once, naming the
      // operation whose stream just went dark, so a caller watching an
      // empty stream is told why it is empty.
      process.stderr.write(
        `progress: ${operation} stream detached after the sink threw: ${describeError(error)}\n`,
      );
    }
  };

  return {
    start(nextStage: string, nextTotal?: number): void {
      assertTerminal("start", stage);
      assertTotal(nextTotal);
      stage = nextStage;
      completed = 0;
      total = nextTotal;
      emit(PROGRESS_KIND.started);
    },
    advance(currentStage: string, by = 1): void {
      assertTerminal("advance", stage);
      if (!Number.isInteger(by) || by <= 0) {
        // A stream whose counter can go backwards, or sit still while
        // claiming to advance, describes a run nobody could follow. The
        // increment is a defect from inside this process, not input.
        throw new RangeError(`progress: advance must be a positive integer, got ${String(by)}`);
      }
      if (stage === null) {
        throw new RangeError(`progress: advance("${currentStage}") before any stage started`);
      }
      if (currentStage !== stage) {
        throw new RangeError(`progress: advance("${currentStage}") during stage "${stage}"`);
      }
      completed += by;
      emit(PROGRESS_KIND.advanced);
    },
    finish(): void {
      assertTerminal("finish", stage);
      emit(PROGRESS_KIND.finished);
      terminated = true;
    },
    stop(reason: ProgressReason): void {
      assertTerminal("stop", stage);
      emit(PROGRESS_KIND.stopped, reason);
      terminated = true;
    },
  };
}

/**
 * Run `body` and terminate `counter` exactly once, whichever way it ends.
 *
 * The rule this enforces is the whole point of the vocabulary having a
 * `finished` member at all: a stream that simply STOPS arriving is the
 * shape of a completed run, a crashed run and a hung run all at once, so
 * an emitter that never terminates has reported nothing a reader can act
 * on. Written here rather than at each operation because five copies of
 * one rule are five chances for one of them to be forgotten - which is
 * exactly what happened to three of the five before this helper existed.
 *
 * A stop carries the reason when the error is a safeguard stop, and no
 * reason otherwise: an unexpected throw is a crash, and calling it a
 * cancellation would be an invented fact. The error always propagates.
 */
export function withProgress<T>(counter: ProgressCounter, body: () => T): T {
  try {
    const result = body();
    counter.finish();
    return result;
  } catch (error) {
    counter.stop(progressReasonForError(error) ?? PROGRESS_REASON.failed);
    throw error;
  }
}

/** {@link withProgress} for an operation whose body is asynchronous. */
export async function withProgressAsync<T>(
  counter: ProgressCounter,
  body: () => Promise<T>,
): Promise<T> {
  try {
    const result = await body();
    counter.finish();
    return result;
  } catch (error) {
    counter.stop(progressReasonForError(error) ?? PROGRESS_REASON.failed);
    throw error;
  }
}

/**
 * The reason a safeguard stop corresponds to, or `null` when `error` is
 * not a safeguard stop at all.
 *
 * Lives here rather than at each of the five long operations because the
 * mapping is one fact - a cancellation is `aborted`, an elapsed deadline
 * is `timed-out` - and five copies of it would be five chances to report
 * a deliberate stop as a failure, which is the distinction
 * `SafeguardAbortError` was created to preserve.
 */
export function progressReasonForError(error: unknown): ProgressReason | null {
  if (error instanceof SafeguardAbortError) return PROGRESS_REASON.aborted;
  if (error instanceof SafeguardTimeoutError) return PROGRESS_REASON.timedOut;
  return null;
}

/** Re-exported so a call site needs one import to emit progress. */
export { OPERATION, type Operation };
