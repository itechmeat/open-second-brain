/**
 * Ctrl-C reaches the operation (nothing-runs-unwatched, U3).
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
 * This module is the missing half. It follows the one working teardown in
 * the repository, `IndexWatchRunner`'s: `process.once`, so a SECOND
 * interrupt is not intercepted and falls through to the default handler
 * that force-kills. A hung synchronous pass must always be killable by
 * pressing the key twice - a JavaScript timer cannot interrupt a
 * fully-synchronous CPU hang on a single thread, and neither can a
 * cooperative signal.
 *
 * The exit code is the shell's own convention rather than a new project
 * vocabulary: 128 plus the signal number. It matters that it is not 0.
 * `o2b search watch` exits 0 when interrupted because stopping IS how
 * that command ends; a consolidation pass interrupted half-way did not
 * do what it was asked, and reporting that as success is exactly the
 * misleading quiet this release removes.
 */

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
  SIGINT: SIGINT_EXIT,
  SIGTERM: SIGTERM_EXIT,
});

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
   * Stop listening. MUST be called in a `finally`: the listeners are
   * process-global, and a verb that returns without releasing leaves a
   * dead controller wired to the next signal.
   */
  readonly release: () => void;
}

/**
 * Listen for an interrupt for the duration of one operation.
 *
 * Deliberately not idempotent across concurrent calls: two overlapping
 * handles would each register a `once` listener and the first signal
 * would abort only one of them. Long verbs are one-per-process here, and
 * a second handle in the same process is a defect worth failing on rather
 * than a case to paper over.
 */
export function onInterrupt(): InterruptHandle {
  const controller = new AbortController();
  let received: HandledSignal | null = null;
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
    release: () => {
      for (const [name, listener] of listeners) process.removeListener(name, listener);
      listeners.clear();
    },
  });
}

/**
 * Report a run the operator stopped, and give back its exit code.
 *
 * Five long verbs reach this arm and every one of them says the same two
 * things: the stop is not a crash, and it is not a success. Written once
 * here rather than retyped per verb, for the reason `progressReasonForError`
 * lives in the spine rather than at each of the operations - five copies of
 * one fact are five chances for one of them to report a deliberate stop as
 * a failure, which is the distinction `SafeguardAbortError` exists to keep.
 *
 * A `--json` caller gets the refusal as a document because its stdout is a
 * payload it parses; a human gets the line on stderr, where the verb's
 * other diagnostics already are. The two are exclusive: a JSON run that
 * also wrote the prose line would put the same fact on two streams, and a
 * human run has no document to put it in.
 */
export function reportInterrupted(handle: InterruptHandle, error: Error, asJson: boolean): number {
  if (asJson) okJson({ ok: false, interrupted: true, message: error.message });
  else process.stderr.write(`${error.message}\n`);
  return handle.exitCode();
}
