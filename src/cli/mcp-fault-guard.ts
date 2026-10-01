/**
 * A served MCP transport survives a stray promise rejection.
 *
 * Before this module `o2b mcp` registered no process-level fault handler,
 * so one promise rejected anywhere in core with nobody awaiting it ended
 * the server with the runtime default: no named line, no count, and a
 * dead server. Claude Code and Codex never restart a dead MCP server
 * mid-session (the Hermes bridge restarts it once), so the operator's
 * agent lost the whole Brain surface over a fault that broke no request.
 *
 * ## Two faults, two answers
 *
 * - An unhandled REJECTION is a promise nobody awaited. The request that
 *   created it has already been answered (or was never a request at all),
 *   and the process state is intact, so the guard names it on stderr with
 *   its first stack frame, counts it, and the server keeps serving.
 *   Logging is rate-limited - {@link REJECTION_LOG_BURST} full lines per
 *   {@link REJECTION_LOG_WINDOW_MS}, then one summary line for the rest of
 *   that window - so a loop that rejects on every tick cannot fill a log
 *   disk; the count is never limited.
 * - An uncaught EXCEPTION unwound a synchronous stack to the top. Nothing
 *   says the state it left behind is consistent, so continuing would
 *   serve answers from a process that is already wrong. The guard names
 *   it and calls `process.exit(EXIT_INTERNAL_FAULT)`. `process.exit`,
 *   unlike the runtime default for an uncaught exception, emits `exit`,
 *   so the two hooks registered there still run: the search store
 *   checkpoints its WAL and the sync lockfile module unlinks every held
 *   lock. No drain is attempted: a drain waits for in-flight work, and
 *   the work in flight is the work that just proved the process is wrong.
 *
 * ## Why it lives on the CLI side
 *
 * The same reason as `mcp-drain.ts`: the process belongs to the CLI. A
 * transport module reaching for `process.on("uncaughtException")` would
 * install it for every host that embeds the transport, including tests
 * and the probe, where a crash SHOULD be loud. Only the two served
 * transports of `o2b mcp` install it, and they release it before the verb
 * returns, so the top-level `main().catch` still fails loudly once the
 * server has stopped. `src/mcp/http.ts` reads the counts through a getter
 * the CLI injects, so `src/mcp` imports nothing from here.
 *
 * `process.on` rather than `once`: with `once`, a second rejection would
 * fall through to the default handler and kill the process - the exact
 * outcome the guard exists to prevent. Every stderr write is wrapped,
 * because a closed stderr must not turn the guard into the crash.
 */

import type { McpFaultCounts } from "../mcp/http.ts";
import { redactRawOutput } from "../core/redactor.ts";
import type { DrainReportStream } from "./mcp-drain.ts";

/** sysexits `EX_SOFTWARE`: distinct from 1 (CLI error) and 130/143 (signals). */
export const EXIT_INTERNAL_FAULT = 70;

/** The two faults the guard handles, as they appear on stderr and `/health`. */
export const FAULT_KIND = Object.freeze({
  unhandledRejection: "unhandled_rejection",
  uncaughtException: "uncaught_exception",
} as const);

export type FaultKind = (typeof FAULT_KIND)[keyof typeof FAULT_KIND];

/** Full rejection lines per window before the rest are summarised. */
export const REJECTION_LOG_BURST = 5;

/** The rate-limit window for rejection lines. */
export const REJECTION_LOG_WINDOW_MS = 60_000;

export interface McpFaultGuardOptions {
  readonly stderr?: DrainReportStream;
  /**
   * How the process ends after an uncaught exception. Injected only by
   * tests; the product uses the real `process.exit`, which is the call
   * that lets the registered `exit` hooks run.
   */
  readonly exit?: (code: number) => void;
  /** The clock for the rate limit and `last_fault_at`. */
  readonly now?: () => Date;
  /**
   * Arms the one-shot timer that flushes the summary of a window once it
   * ends. Injected only by tests; the product uses an unref'd
   * `setTimeout`.
   */
  readonly schedule?: FaultGuardScheduler;
}

/** Run `fire` once after `delayMs`; the returned function cancels it. */
export type FaultGuardScheduler = (fire: () => void, delayMs: number) => () => void;

/**
 * The product scheduler: unref'd, so the timer never holds a stopping
 * process open.
 */
const unrefTimeout: FaultGuardScheduler = (fire, delayMs) => {
  const timer = setTimeout(fire, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Redaction applied to every line the guard writes: an error message can
 * carry a credential-bearing URL or a token echoed by a provider, and a
 * stdio host captures this stderr into its own log files.
 */
const FAULT_LINE_REDACTION = Object.freeze({ redactTokens: true, redactUrlCredentials: true });

export interface McpFaultGuardHandle {
  /** A snapshot of the counts, the shape `/health` reports. */
  counts(): McpFaultCounts;
  /**
   * Stop listening and flush a pending summary line. MUST be called when
   * the server stops: the listeners are process-global. Idempotent.
   */
  release(): void;
}

/** Install the process-level fault handlers for a served MCP transport. */
export function installMcpFaultGuard(opts: McpFaultGuardOptions = {}): McpFaultGuardHandle {
  const stderr = opts.stderr ?? process.stderr;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? (() => new Date());
  const schedule = opts.schedule ?? unrefTimeout;

  let rejections = 0;
  let exceptions = 0;
  let lastFaultAt: string | null = null;
  let windowStartMs = Number.NEGATIVE_INFINITY;
  let loggedInWindow = 0;
  let suppressedInWindow = 0;
  let cancelSummary: (() => void) | null = null;
  let exiting = false;
  let released = false;

  const write = (chunk: string): void => {
    try {
      stderr.write(redactRawOutput(chunk, FAULT_LINE_REDACTION));
    } catch {
      // A closed stderr has nowhere to report to; the count still records it.
    }
  };

  const flushSummary = (): void => {
    if (cancelSummary !== null) {
      cancelSummary();
      cancelSummary = null;
    }
    if (suppressedInWindow === 0) return;
    write(
      `[mcp] ${FAULT_KIND.unhandledRejection}: ${suppressedInWindow} more suppressed ` +
        `in the last ${REJECTION_LOG_WINDOW_MS}ms\n`,
    );
    suppressedInWindow = 0;
  };

  const onRejection = (reason: unknown): void => {
    try {
      rejections += 1;
      const at = now();
      lastFaultAt = at.toISOString();
      const atMs = at.getTime();
      if (atMs - windowStartMs >= REJECTION_LOG_WINDOW_MS) {
        flushSummary();
        windowStartMs = atMs;
        loggedInWindow = 0;
      }
      if (loggedInWindow < REJECTION_LOG_BURST) {
        loggedInWindow += 1;
        write(
          `[mcp] ${FAULT_KIND.unhandledRejection} #${rejections}: ${describeReason(reason)} ` +
            `(server keeps serving)\n${firstFrameLine(reason)}`,
        );
        return;
      }
      suppressedInWindow += 1;
      // A quiet server still reports what it suppressed once the window
      // ends.
      if (cancelSummary === null) {
        cancelSummary = schedule(flushSummary, windowStartMs + REJECTION_LOG_WINDOW_MS - atMs);
      }
    } catch {
      // The guard must never become the fault it is guarding against.
    }
  };

  const onException = (error: unknown): void => {
    if (exiting) {
      exit(EXIT_INTERNAL_FAULT);
      return;
    }
    exiting = true;
    try {
      exceptions += 1;
      lastFaultAt = now().toISOString();
      flushSummary();
      write(
        `[mcp] ${FAULT_KIND.uncaughtException}: ${describeReason(error)}; ` +
          `exiting ${EXIT_INTERNAL_FAULT} so the exit hooks checkpoint the index and release locks\n` +
          firstFrameLine(error),
      );
    } catch {
      // Fall through to the exit: a half-written report beats a hung process.
    }
    exit(EXIT_INTERNAL_FAULT);
  };

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  return Object.freeze({
    counts: (): McpFaultCounts =>
      Object.freeze({
        unhandled_rejection: rejections,
        uncaught_exception: exceptions,
        last_fault_at: lastFaultAt,
      }),
    release: (): void => {
      if (released) return;
      released = true;
      process.removeListener("unhandledRejection", onRejection);
      process.removeListener("uncaughtException", onException);
      flushSummary();
    },
  });
}

/** `Error: message` for an Error, a quoted value for anything else. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  let shown: string;
  try {
    shown = JSON.stringify(reason) ?? String(reason);
  } catch {
    // BigInt, a cycle, a throwing toJSON: fall back to the coercion.
    try {
      shown = String(reason);
    } catch {
      shown = Object.prototype.toString.call(reason);
    }
  }
  return `non-error reason: ${shown}`;
}

/** The first `at ...` frame of an Error's stack, as its own line, or nothing. */
function firstFrameLine(reason: unknown): string {
  if (!(reason instanceof Error) || typeof reason.stack !== "string") return "";
  const frame = reason.stack.split("\n").find((line) => line.trimStart().startsWith("at "));
  return frame === undefined ? "" : `[mcp]   ${frame.trim()}\n`;
}
