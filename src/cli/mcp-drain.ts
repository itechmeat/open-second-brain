/**
 * SIGTERM and SIGINT reach a running MCP server.
 *
 * `src/mcp/drain.ts` knows how to wait for in-flight requests and knows
 * nothing about signals; `src/cli/interrupt.ts` owns this project's
 * signal vocabulary - `SIGINT_EXIT = 130`, `SIGTERM_EXIT = 143` - and
 * knows nothing about transports. This module is the ten lines that join
 * them, and it lives on the CLI side because the process belongs to the
 * CLI: a transport module reaching for `process.once("SIGTERM")` is how a
 * project ends up with two signal conventions.
 *
 * ## Why it exits rather than re-raising
 *
 * `interrupt.ts` settles an unacknowledged signal by removing its own
 * listeners and re-raising, so the default disposition ends the process
 * the way the keystroke would have. That is right for a foreground verb
 * and wrong here. Two `process.on("exit")` hooks have to run AFTER the
 * transport closes - `src/core/search/store-exit.ts` synchronously
 * checkpoints the WAL of every open writer, and
 * `src/core/brain/sync-lockfile.ts` unlinks every held lock - and the
 * default disposition for a terminating signal runs neither: the process
 * dies by signal, not by exit, and no `exit` event is emitted. Calling
 * `process.exit(128 + signo)` reports the same thing to the shell AND
 * emits `exit`, so both hooks run, in their own registration order, once
 * the last request has been answered. That ordering is the whole reason
 * the drain has to complete before the exit rather than beside it.
 *
 * `process.once` rather than `process.on`, matching `interrupt.ts`: a
 * SECOND signal is not intercepted and falls through to the default
 * handler that kills immediately, so an operator who decides the drain is
 * taking too long is never trapped by it.
 */

import { EXIT_INTERRUPTED, EXIT_TERMINATED } from "./interrupt.ts";
import { describeAbandonedRequests, DRAIN_STATE, type DrainOutcome } from "../mcp/drain.ts";

/** The signals a served transport shuts down for. */
const HANDLED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"] as const);

type HandledSignal = (typeof HANDLED_SIGNALS)[number];

const EXIT_FOR_SIGNAL: Readonly<Record<HandledSignal, number>> = Object.freeze({
  SIGINT: EXIT_INTERRUPTED,
  SIGTERM: EXIT_TERMINATED,
});

/** The narrow slice of a stream this module writes to. */
export interface DrainReportStream {
  write(chunk: string): void;
}

export interface McpSignalDrainOptions {
  /** Stop accepting, await in-flight work, close. Usually `handle.close`. */
  readonly close: () => Promise<DrainOutcome>;
  readonly stderr?: DrainReportStream;
  /**
   * How the process ends. Injected only by tests, which cannot let a
   * real `process.exit` run; the product uses the real one, and it is
   * the call that lets the registered `exit` hooks run.
   */
  readonly exit?: (code: number) => void;
}

export interface McpSignalDrainHandle {
  /**
   * The exit code for the signal that arrived, or `null` while none has.
   *
   * The caller returns it, because the caller is also awaiting the
   * transport's own close and there is no ordering between "the close
   * promise resolves" and "the handler's `exit` runs". Whichever wins,
   * the process ends with the same code - the handler's `process.exit`
   * and the verb's return value agree by construction rather than by
   * timing.
   */
  readonly exitCode: () => number | null;
  /**
   * Stop listening. MUST be called when the server stops for a reason
   * other than a signal: the listeners are process-global, and one left
   * behind would drain a transport that has already gone.
   */
  readonly release: () => void;
}

/**
 * Drain and close the transport when a shutdown signal arrives.
 *
 * Returns immediately; the work happens in the handler. A drain that hits
 * its deadline still exits - the requests it gave up on are NAMED on
 * stderr first, because a shutdown that silently truncates a tool call is
 * indistinguishable from a crash to whoever was waiting on it.
 */
export function installMcpSignalDrain(opts: McpSignalDrainOptions): McpSignalDrainHandle {
  const stderr = opts.stderr ?? process.stderr;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const listeners = new Map<HandledSignal, () => void>();
  let released = false;
  let exitCode: number | null = null;

  const release = (): void => {
    if (released) return;
    released = true;
    for (const [name, listener] of listeners) process.removeListener(name, listener);
    listeners.clear();
  };

  for (const name of HANDLED_SIGNALS) {
    const listener = (): void => {
      exitCode = EXIT_FOR_SIGNAL[name];
      stderr.write(`[mcp] ${name} received; draining in-flight requests before closing\n`);
      void opts
        .close()
        .then((outcome) => {
          if (outcome.state === DRAIN_STATE.deadlineExpired) {
            stderr.write(describeAbandonedRequests(outcome));
          } else {
            stderr.write(`[mcp] drained in ${outcome.waited_ms}ms; closing\n`);
          }
        })
        .catch((error: unknown) => {
          stderr.write(`[mcp] shutdown failed while draining: ${String(error)}\n`);
        })
        .finally(() => {
          release();
          exit(EXIT_FOR_SIGNAL[name]);
        });
    };
    listeners.set(name, listener);
    process.once(name, listener);
  }

  return Object.freeze({ exitCode: () => exitCode, release });
}
