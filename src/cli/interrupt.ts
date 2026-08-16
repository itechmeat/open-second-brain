/**
 * Ctrl-C reaches the operations that can hear it (nothing-runs-unwatched, U3).
 *
 * The cooperative-cancellation contract was already written and never
 * connected. `createSafeguard` accepts a `signal`, checks it in priority
 * over the deadline, and throws `SafeguardAbortError` - a class kept
 * deliberately distinct from `SafeguardTimeoutError` so, in its own
 * words, "the watch shutdown coordinator can treat an intentional abort
 * as a clean stop rather than a failure". Not one production call site
 * passed a signal, so that class was unreachable and every long verb had
 * exactly one way to stop: the deadline, or SIGKILL.
 *
 * This module is the missing half, and it is deliberately smaller than
 * the half that was first written here.
 *
 * ## Why four of the six operations get no handle at all
 *
 * A Node/Bun signal handler is a JavaScript callback dispatched from the
 * event loop. `dreamRun`, `detectCommunitiesRun`, `discoverBridgesRun`
 * and `generateRun` are declared `function`, not `async`, and contain no
 * `await`: from the moment the pass starts until the moment it returns,
 * the process never re-enters the event loop, so the handler cannot run.
 * Measured against these exact modules - a real SIGINT delivered 0.3 s
 * into a synchronous `checkpoint()` loop - 27,356,853 checkpoints ran
 * with the signal pending, `SafeguardAbortError` was never thrown, and
 * `received()` was still `null` when the loop ended. One turn of the
 * event loop later it was `"SIGINT"`. The signal was never lost; it was
 * unobservable for the entire duration of the work.
 *
 * `safeguard.ts` already states the general form of this - "a JavaScript
 * timer cannot interrupt a fully-synchronous CPU hang on a single
 * thread" - and frames it as the pathological case. For these four it is
 * the NORMAL case: they are synchronous end to end, so the whole pass is
 * a region no cooperative signal can enter.
 *
 * Making them `async` does not fix it and would hide it. An `await` on a
 * resolved promise is a MICROtask, and microtasks drain without ever
 * yielding to libuv: 4,810,652 `await Promise.resolve()` iterations with
 * a SIGINT pending, and `received()` still `null`. Only a macrotask yield
 * (`setImmediate`) lets the handler run, at ~184 k yields/s against
 * ~13.7 M synchronous checkpoints/s. An async rewrite would therefore
 * have to insert a purpose-built macrotask yield at every checkpoint
 * across 137 call sites - and if any one of them used a plain `await`, it
 * would reproduce this exact false claim invisibly.
 *
 * So the honest answer is not to make the handler work where it cannot.
 * It is to install it only where the operation actually yields, and to
 * leave the default disposition in place everywhere else - where the
 * keystroke keeps doing what it did before this branch existed: killing
 * the process at once. Those four write atomically (`atomicWriteFileSync`
 * in dream, plan-then-write under one lock in architect), so a pass
 * killed mid-way leaves no half-written artifact.
 *
 * ## Why an unobserved signal still ends the run
 *
 * Registering a listener suppresses the default terminate for as long as
 * it is registered, and every verb holds the handle across work that
 * never consults the signal: `Store.open`, a proposal write, a report
 * render, the reindex swap. A Ctrl-C landing there aborted a controller
 * nobody read, and the verb returned 0 - a success code for a run the
 * operator stopped. So {@link InterruptHandle.release} reconciles: a
 * signal that arrived and was never acknowledged is re-raised, which ends
 * the process the way the keystroke would have. Suppressing the default
 * is a loan against the operation acting on it, and `release` is where
 * the loan is called in.
 *
 * `process.once` rather than `process.on`, following the one working
 * teardown in the repository, `IndexWatchRunner`'s: a SECOND interrupt is
 * not intercepted and falls through to the default handler that
 * force-kills.
 *
 * The exit code is the shell's own convention rather than a new project
 * vocabulary: 128 plus the signal number. It matters that it is not 0.
 * `o2b search watch` exits 0 when interrupted because stopping IS how
 * that command ends; a consolidation pass interrupted half-way did not
 * do what it was asked, and reporting that as success is exactly the
 * misleading quiet this release removes.
 */

import { OPERATION, type Operation } from "../core/brain/safeguard.ts";

import { okJson } from "./output.ts";

const SIGINT_EXIT = 130;
const SIGTERM_EXIT = 143;

/**
 * Exit code for a run the operator stopped with Ctrl-C. 128 + SIGINT(2).
 */
export const EXIT_INTERRUPTED = SIGINT_EXIT;

/** Exit code for a run stopped by SIGTERM. 128 + SIGTERM(15). */
export const EXIT_TERMINATED = SIGTERM_EXIT;

/** The signals a long foreground verb listens for. */
const HANDLED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"] as const);

type HandledSignal = (typeof HANDLED_SIGNALS)[number];

const EXIT_FOR_SIGNAL: Readonly<Record<HandledSignal, number>> = Object.freeze({
  SIGINT: EXIT_INTERRUPTED,
  SIGTERM: EXIT_TERMINATED,
});

/**
 * Whether each long operation yields to the event loop while it runs.
 *
 * One table rather than a convention followed six times, for the reason
 * `progressReasonForError` lives in the spine: the fact that decides
 * whether a handle may be opened is the fact a reader needs, and six
 * copies of it are six chances for the seventh verb to guess. A new
 * member of `OPERATION` cannot compile without answering here, which is
 * the point - the question is easy to answer and impossible to ask
 * yourself unprompted.
 *
 * `reindex` awaits real I/O between files and between embed batches, and
 * checks `throwIfAborted` at both boundaries. The maintenance lane awaits
 * between its four tasks, so a signal delivered during one task is seen
 * before the next one starts - which is also why the lane's own
 * sub-passes are listed `false` here and cancelled through the lane
 * rather than on their own.
 */
const YIELDS_TO_EVENT_LOOP: Readonly<Record<Operation, boolean>> = Object.freeze({
  [OPERATION.dream]: false,
  [OPERATION.bridges]: false,
  [OPERATION.clusters]: false,
  [OPERATION.architect]: false,
  [OPERATION.reindex]: true,
  [OPERATION.maintenance]: true,
  // The session sweep is synchronous end to end: the walk and the hash
  // pass are both sync fs calls, so a signal handler cannot run while it
  // does. Leaving SIGINT alone keeps the keystroke lethal, which is the
  // only way this pass can actually be stopped.
  [OPERATION.sessions]: false,
});

/**
 * Whether a cooperative interrupt can reach `operation` at all.
 *
 * The predicate a verb consults before it decides to advertise Ctrl-C,
 * and the predicate `docs/cli-reference.md` is written from.
 */
export function interruptIsObservable(operation: Operation): boolean {
  return YIELDS_TO_EVENT_LOOP[operation];
}

export interface InterruptHandle {
  /** Hand this to `createSafeguard`; the next checkpoint throws when set. */
  readonly signal: AbortSignal;
  /** Which signal arrived, or `null` while none has. */
  readonly received: () => HandledSignal | null;
  /**
   * The exit code for the signal that arrived, or {@link EXIT_INTERRUPTED}
   * when a stop is reported without one - an abort raised by a caller
   * rather than by a key press.
   */
  readonly exitCode: () => number;
  /**
   * Declare that the run has acted on the interrupt: it stopped at a
   * checkpoint and the verb is about to return {@link exitCode}. Called
   * for you by {@link reportInterrupted}; a verb that reports a stop its
   * own way - the maintenance lane does, from its journal - calls it
   * directly.
   *
   * Without it {@link release} cannot tell a stop that was honoured from
   * a signal that was swallowed, and it must assume the latter, because
   * assuming the former is how a stopped run exits 0.
   */
  readonly acknowledge: () => void;
  /**
   * Stop listening, and settle an interrupt nobody acted on.
   *
   * MUST be called in a `finally`: the listeners are process-global, and
   * a verb that returns without releasing leaves a dead controller wired
   * to the next signal. When a signal arrived and {@link acknowledge} was
   * never called, this does not return - it re-raises, ending the process
   * as the un-suppressed keystroke would have.
   */
  readonly release: () => void;
}

/** Thrown when a handle is asked for on behalf of an operation that cannot see it. */
export class UnobservableInterruptError extends Error {
  readonly operation: Operation;

  constructor(operation: Operation) {
    super(
      `${operation} runs to completion without yielding to the event loop, so a ` +
        "signal handler cannot run while it does. Opening a handle would only " +
        "suppress the default terminate and swallow the operator's Ctrl-C; leave " +
        "the signal alone so the keystroke still stops the process.",
    );
    this.name = "UnobservableInterruptError";
    this.operation = operation;
  }
}

/**
 * Listen for an interrupt for the duration of one `operation`.
 *
 * Throws {@link UnobservableInterruptError} for an operation that cannot
 * observe one. A handle that installed nothing would be worse than the
 * throw: the call site would read as cancelled-on-request and behave as
 * uncancellable, which is the state this module was written to end.
 *
 * Concurrent handles are not supported and are not defended against. Node
 * dispatches a signal to EVERY registered listener, so two overlapping
 * handles both abort - the hazard is not a missed abort but a `release`
 * on one handle re-raising a signal the other already acted on. Long
 * verbs are one-per-process here; `cmdBrainDream` opens its staged handle
 * and the inline one sequentially, never at once.
 */
export function onInterrupt(operation: Operation): InterruptHandle {
  if (!interruptIsObservable(operation)) throw new UnobservableInterruptError(operation);

  const controller = new AbortController();
  let received: HandledSignal | null = null;
  let acknowledged = false;
  let released = false;
  const listeners = new Map<HandledSignal, () => void>();

  for (const name of HANDLED_SIGNALS) {
    const listener = (): void => {
      received = name;
      controller.abort();
    };
    listeners.set(name, listener);
    process.once(name, listener);
  }

  return Object.freeze({
    signal: controller.signal,
    received: () => received,
    exitCode: () => (received === null ? EXIT_INTERRUPTED : EXIT_FOR_SIGNAL[received]),
    acknowledge: () => {
      acknowledged = true;
    },
    release: () => {
      if (released) return;
      released = true;
      for (const [name, listener] of listeners) process.removeListener(name, listener);
      listeners.clear();
      if (received === null || acknowledged) return;
      const signal = received;
      process.stderr.write(
        `interrupted: ${signal} arrived while ${operation} was in a region that does not ` +
          "check for it, so the run could not stop at a boundary; stopping now\n",
      );
      // Our listeners are gone, so with nothing else holding this signal
      // the default disposition is back and this call does not return.
      process.kill(process.pid, signal);
      // Reached only when another subsystem in this process still holds a
      // listener for the signal and absorbed the re-raise. The run must
      // still not report success, so it ends here by exit code instead.
      process.exit(EXIT_FOR_SIGNAL[signal]);
    },
  });
}

/**
 * Report a run the operator stopped, and give back its exit code.
 *
 * The long verbs that reach this arm all say the same two things: the
 * stop is not a crash, and it is not a success. Written once here rather
 * than retyped per verb, for the reason `progressReasonForError` lives in
 * the spine rather than at each of the operations - copies of one fact
 * are chances for one of them to report a deliberate stop as a failure,
 * which is the distinction `SafeguardAbortError` exists to keep.
 *
 * Acknowledging is part of reporting, not a second step a caller could
 * forget: a stop that has been reported has been acted on, and `release`
 * must not then re-raise it.
 *
 * A `--json` caller gets the refusal as a document because its stdout is a
 * payload it parses; a human gets the line on stderr, where the verb's
 * other diagnostics already are. The two are exclusive: a JSON run that
 * also wrote the prose line would put the same fact on two streams, and a
 * human run has no document to put it in.
 */
export function reportInterrupted(handle: InterruptHandle, error: Error, asJson: boolean): number {
  handle.acknowledge();
  if (asJson) okJson({ ok: false, interrupted: true, message: error.message });
  else process.stderr.write(`${error.message}\n`);
  return handle.exitCode();
}
