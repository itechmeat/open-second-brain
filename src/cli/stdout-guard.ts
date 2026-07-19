/**
 * Stdout EPIPE guard for the CLI entry points (`o2b` and `vault-log`).
 *
 * When a downstream reader closes the pipe early (`o2b <listing> | head -1`),
 * the next write to stdout fails with EPIPE. That is the normal, benign end of
 * a shell pipeline, not a program error: the CLI must exit 0 with no
 * diagnostic. Every OTHER stdout write failure (ENOSPC, EIO, ...) is a real
 * I/O fault and must keep failing loudly with its message and a nonzero exit,
 * never silently swallowed.
 *
 * This is the single sanctioned EPIPE special case in the codebase and it is
 * scoped to stdout only; error handling elsewhere stays unchanged.
 */

/** The Node/Bun errno code for a write to a pipe with no reader. */
export const EPIPE_CODE = "EPIPE";

interface ErrnoLike {
  readonly code?: unknown;
}

/** True when `err` is an EPIPE errno error (object carrying `code: "EPIPE"`). */
export function isEpipeError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as ErrnoLike).code === EPIPE_CODE;
}

/** Side-effecting outcome of a stdout error, injected so the mapping is testable. */
export interface StreamErrorSink {
  /** Terminate the process with `code`. */
  readonly exit: (code: number) => never;
  /** Emit a diagnostic (to stderr in production). */
  readonly writeError: (message: string) => void;
}

/**
 * Map a stdout stream error to a process outcome: EPIPE exits 0 silently;
 * every other error is reported and exits nonzero. Never returns.
 */
export function handleStdoutError(err: unknown, sink: StreamErrorSink): never {
  if (isEpipeError(err)) {
    return sink.exit(0);
  }
  const message = err instanceof Error ? err.message : String(err);
  sink.writeError(`error: ${message}\n`);
  return sink.exit(1);
}

/** The production sink: real `process.exit` and a fail-soft stderr write. */
const PROCESS_SINK: StreamErrorSink = {
  exit: (code: number): never => process.exit(code),
  writeError: (message: string): void => {
    try {
      process.stderr.write(message);
    } catch {
      // stderr is gone too; there is nowhere left to report, so just exit.
    }
  },
};

/**
 * Install the guard on `process.stdout` for the real CLI entry point. Bun
 * surfaces a closed-pipe write as an asynchronous `error` event rather than a
 * synchronous throw, so the listener is the primary path; the entry point's
 * promise `.catch` handles the synchronous-throw case (see main.ts).
 */
export function installStdoutEpipeGuard(): void {
  process.stdout.on("error", (err: unknown) => handleStdoutError(err, PROCESS_SINK));
}
