/**
 * Output guard and exit for the CLI entry points (`o2b` and `vault-log`).
 *
 * When a downstream reader closes the pipe early (`o2b <listing> | head -1`),
 * the next write to stdout fails with EPIPE. That is the normal, benign end of
 * a shell pipeline, not a program error: the CLI must exit 0 with no
 * diagnostic. Every OTHER stdout write failure (ENOSPC, EIO, ...) is a real
 * I/O fault and must keep failing loudly with its message and a nonzero exit,
 * never silently swallowed.
 *
 * The exit itself waits for stdout to hand its output over
 * (`exitWhenFlushed`): into a pipe, an exit straight after a large write
 * threw the unread tail away. While that final flush runs, the command has
 * already decided its exit code, so an EPIPE then ends the process with
 * that code, not with 0.
 *
 * This is the single sanctioned EPIPE special case in the codebase; error
 * handling elsewhere stays unchanged.
 */

import { writeSync } from "node:fs";

/** The Node/Bun errno code for a write to a pipe with no reader. */
export const EPIPE_CODE = "EPIPE";

/** The errno-style code of a write to a stream that was already ended. */
export const WRITE_AFTER_END_CODE = "ERR_STREAM_WRITE_AFTER_END";

/**
 * How long the final flush waits on Windows for stdout's `end()` callback
 * before it gives up. On every other platform there is no bound: the
 * process waits for the callback or for EPIPE, as any filter in a pipeline
 * does, so a reader that pauses (a pager left open, `| (sleep 60; jq)`)
 * still receives everything, and Ctrl-C ends the wait at once.
 *
 * The bound exists only because delivery of that callback on Windows is
 * unproven: no Windows run has shown it arriving for a console, a pipe and
 * a closed pipe alike. When it fires, the output may be incomplete, so the
 * exit says so on stderr and is never a success. It can go once Windows CI
 * proves the callback arrives.
 */
export const WINDOWS_FLUSH_BOUND_MS = 30_000;

interface ErrnoLike {
  readonly code?: unknown;
}

/** True when `err` is an EPIPE errno error (object carrying `code: "EPIPE"`). */
export function isEpipeError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as ErrnoLike).code === EPIPE_CODE;
}

function isWriteAfterEnd(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as ErrnoLike).code === WRITE_AFTER_END_CODE
  );
}

/** Side-effecting outcome of a stdout error, injected so the mapping is testable. */
export interface StreamErrorSink {
  /** Terminate the process with `code`. */
  readonly exit: (code: number) => never;
  /** Emit a diagnostic (to stderr in production). */
  readonly writeError: (message: string) => void;
}

/**
 * The final flush's state: whether it has begun and the exit code the
 * command returned. `null` code means no flush has begun.
 */
export interface FlushState {
  code: number | null;
}

/**
 * Map a stdout stream error to a process outcome. Never returns.
 *
 * Before the final flush: EPIPE exits 0 silently; every other error is
 * reported and exits 1. During it (`state.code` set): a write after the
 * stream was ended is ignored by the caller, EPIPE exits with the command's
 * own code, and any other error is reported and exits with that code, or 1
 * when the command had succeeded, since its output did not arrive.
 */
export function handleStdoutError(
  err: unknown,
  sink: StreamErrorSink,
  state: FlushState = { code: null },
): never {
  const decided = state.code;
  if (isEpipeError(err)) {
    return sink.exit(decided ?? 0);
  }
  const message = err instanceof Error ? err.message : String(err);
  sink.writeError(`error: ${message}\n`);
  return sink.exit(decided !== null && decided !== 0 ? decided : 1);
}

/**
 * The production sink: real `process.exit`, and a diagnostic written
 * synchronously to descriptor 2. A stream write could land on a stderr
 * the final flush already ended, and the message would be lost.
 */
const PROCESS_SINK: StreamErrorSink = {
  exit: (code: number): never => process.exit(code),
  writeError: (message: string): void => {
    try {
      writeSync(2, message);
    } catch {
      // stderr is gone too; there is nowhere left to report, so just exit.
    }
  },
};

/** The process's own flush state; only the real exit path changes it. */
const PROCESS_STATE: FlushState = { code: null };

/**
 * Install the guard on `process.stdout` and `process.stderr` for a real
 * CLI entry point. Bun surfaces a closed-pipe write as an asynchronous
 * `error` event rather than a synchronous throw, so the listener is the
 * primary path; the entry point's promise `.catch` handles the
 * synchronous-throw case (see main.ts).
 *
 * stderr gets a listener too: a diagnostic written after its reader closed
 * has nowhere to go, and without a listener that write crashed the
 * process. Any other stderr error is rethrown, as an unhandled one was
 * before. The final flush never ends stderr, so a line written to it late
 * (a signal handler's drain report, an `exit` hook) still goes out.
 */
export function installStdoutEpipeGuard(): void {
  process.stdout.on("error", (err: unknown) => {
    // Once the final flush has ended stdout, a late write from work still
    // running has nowhere to go and is not a failure of the command.
    if (PROCESS_STATE.code !== null && isWriteAfterEnd(err)) return;
    handleStdoutError(err, PROCESS_SINK, PROCESS_STATE);
  });
  process.stderr.on("error", (err: unknown) => {
    if (isEpipeError(err)) return;
    throw err;
  });
}

/** The stream the final flush ends: what `process.stdout` is. */
export interface FlushableStream {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  end(callback: () => void): unknown;
}

/** What the final flush acts on, injected for tests. */
export interface FlushExitDeps {
  readonly stdout: FlushableStream;
  readonly exit: (code: number) => void;
  /** Decides whether a bound is armed at all: only on `win32`. */
  readonly platform: NodeJS.Platform;
  /** The Windows bound in milliseconds ({@link WINDOWS_FLUSH_BOUND_MS}). */
  readonly boundMs: number;
  /** Arms the bound; returns nothing the flush needs. */
  readonly setBound: (fire: () => void, ms: number) => void;
  /** Writes the bound's diagnostic; synchronous to descriptor 2 in production. */
  readonly writeDiagnostic: (message: string) => void;
  /** The state the error listeners read; the process's own by default. */
  readonly state: FlushState;
}

/** The real streams, exit, platform and bound of this process. */
export const PROCESS_FLUSH_DEPS: FlushExitDeps = Object.freeze({
  stdout: process.stdout,
  exit: (code: number): void => process.exit(code),
  platform: process.platform,
  boundMs: WINDOWS_FLUSH_BOUND_MS,
  // Referenced: when the callback never comes, the bound is what ends the
  // process, loudly, rather than an emptied event loop ending it silently
  // with a success code.
  setBound: (fire: () => void, ms: number): void => {
    setTimeout(fire, ms);
  },
  writeDiagnostic: PROCESS_SINK.writeError,
  state: PROCESS_STATE,
});

/**
 * Exit with `code` once stdout has handed over everything written to it.
 *
 * Into a pipe, a write the reader has not taken yet still waits in this
 * process, and `process.exit` right after the write threw that tail away:
 * `o2b help --json | jq` received the first 131072 bytes of the manifest.
 * Under Bun neither a write callback nor `drain` waits for that tail; the
 * callback of `end()` does. A stdout that is already closed is not waited
 * for, and an `end()` that throws counts as done. Only on Windows a bound
 * ({@link WINDOWS_FLUSH_BOUND_MS}) limits the wait; when it fires, the
 * process says so on stderr and exits with the command's code when that
 * is not 0, otherwise with 1.
 *
 * stderr is left open, as every earlier release left it. Ending it too
 * lost every line written after the flush began: the drain report a
 * signal handler of `o2b mcp` writes while the process closes, and what an
 * `exit` hook writes as the process ends. A diagnostic of a failed stdout
 * goes straight to descriptor 2 (see `PROCESS_SINK`), so it never waits
 * on the stream either.
 */
export function exitWhenFlushed(code: number, deps: FlushExitDeps = PROCESS_FLUSH_DEPS): void {
  deps.state.code = code;
  // Only the process's own flush sets the process's exit code; a test
  // double with a state of its own leaves it alone.
  if (deps.state === PROCESS_STATE) process.exitCode = code;
  let exited = false;
  const exit = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(exitCode);
  };
  if (deps.platform === "win32") {
    deps.setBound(() => {
      if (exited) return;
      deps.writeDiagnostic(
        `error: standard output did not finish within ${Math.round(deps.boundMs / 1000)} s; ` +
          "what it had not handed over is lost\n",
      );
      exit(code !== 0 ? code : 1);
    }, deps.boundMs);
  }
  const { stdout } = deps;
  if (stdout.destroyed === true || stdout.writableEnded === true) {
    exit(code);
    return;
  }
  try {
    stdout.end(() => exit(code));
  } catch {
    exit(code);
  }
}
