/**
 * Operation safeguard (t_06784b8d, upstream:mirage): cooperative
 * deadline + output caps for long-running brain operations (dream,
 * reindex, bridge discovery, communities, maintenance lane).
 *
 * Bun runs SQLite synchronously, so a preemptive timeout would have
 * to lie - wrapping sync work in a fake async race never actually
 * cancels it. The honest contract is cooperative: an operation
 * receives a `Safeguard` and calls `checkpoint()` at its natural
 * iteration boundaries (per file, per candidate pair, per propagation
 * sweep, per lane task). Past the deadline the NEXT checkpoint throws
 * `SafeguardTimeoutError`; writes stay atomic, so a tripped operation
 * stops at a boundary instead of half-writing an artifact.
 *
 * Timeout resolution mirrors mirage's ladder: per-operation config
 * key (`safeguard_timeout_<op>_seconds`) -> global key
 * (`safeguard_timeout_seconds`, env mirror
 * `OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT`) -> built-in default. `0`
 * disables the deadline. Invalid values fail soft to the default -
 * a typo in a timeout must never break the operation it guards.
 */

import { discoverConfig } from "../config.ts";

/** Operations that accept a safeguard. */
export type SafeguardOperation = "dream" | "reindex" | "bridges" | "clusters" | "maintenance";

/** Built-in fallback budget (mirage uses 600s; same scale fits here). */
export const SAFEGUARD_DEFAULT_TIMEOUT_SECONDS = 600;

export class SafeguardTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(
      `${operation} exceeded its safeguard timeout of ${timeoutMs}ms - aborted at a checkpoint`,
    );
    this.name = "SafeguardTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when an operation's `AbortSignal` is aborted on demand (not a
 * deadline). Distinct from `SafeguardTimeoutError` so callers - notably
 * the watch shutdown coordinator - can treat an intentional abort as a
 * clean stop rather than a failure.
 */
export class SafeguardAbortError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`${operation} was aborted at a checkpoint`);
    this.name = "SafeguardAbortError";
    this.operation = operation;
  }
}

/**
 * Cooperative abort check for hot loops that hold a signal but not a
 * full `Safeguard`. Throws `SafeguardAbortError` when the signal is
 * aborted; a no-op for a live or absent signal.
 */
export function throwIfAborted(signal?: AbortSignal, operation = "operation"): void {
  if (signal?.aborted === true) throw new SafeguardAbortError(operation);
}

export interface Safeguard {
  /** Throws `SafeguardTimeoutError` when the deadline has passed. */
  checkpoint(): void;
  /** The active budget, or null when the deadline is disabled. */
  readonly timeoutMs: number | null;
  /** The operation this guard protects (for error reporting). */
  readonly operation: string;
}

export interface CreateSafeguardOptions {
  readonly operation: SafeguardOperation | string;
  /** Budget in milliseconds; `0`, `null`, or `undefined` disable. */
  readonly timeoutMs?: number | null;
  /** Injected clock (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Optional on-demand cancellation. When aborted, the next
   * `checkpoint()` throws `SafeguardAbortError` - checked in priority
   * over the deadline. A signal with no deadline still produces a live
   * guard (no downgrade to noop).
   */
  readonly signal?: AbortSignal;
}

/** A no-deadline guard for callers that need a Safeguard-shaped arg. */
export function noopSafeguard(operation = "unguarded"): Safeguard {
  return Object.freeze({
    operation,
    timeoutMs: null,
    checkpoint: () => {},
  });
}

export function createSafeguard(opts: CreateSafeguardOptions): Safeguard {
  const budget =
    opts.timeoutMs === undefined || opts.timeoutMs === null || opts.timeoutMs <= 0
      ? null
      : opts.timeoutMs;
  const signal = opts.signal;
  // No deadline AND no signal: nothing to guard.
  if (budget === null && signal === undefined) return noopSafeguard(opts.operation);
  const now = opts.now ?? Date.now;
  const deadline = budget === null ? null : now() + budget;
  return Object.freeze({
    operation: opts.operation,
    timeoutMs: budget,
    checkpoint: () => {
      // Abort wins over the deadline: an intentional cancellation is
      // reported as such, not masked as a timeout.
      if (signal?.aborted === true) throw new SafeguardAbortError(opts.operation);
      if (budget !== null && deadline !== null && now() > deadline) {
        throw new SafeguardTimeoutError(opts.operation, budget);
      }
    },
  });
}

/**
 * Resolve the timeout budget for one operation in milliseconds.
 * Returns `null` when the resolved value is `0` (disabled).
 */
export function resolveSafeguardTimeoutMs(
  operation: SafeguardOperation,
  configPath?: string,
): number | null {
  let config: Readonly<Record<string, string>>;
  try {
    config = discoverConfig(configPath).data;
  } catch {
    config = {};
  }
  const perOp = parseSeconds(config[`safeguard_timeout_${operation}_seconds`]);
  if (perOp !== undefined) return perOp === 0 ? null : perOp * 1000;
  const envGlobal = parseSeconds(process.env["OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT"]);
  if (envGlobal !== undefined) return envGlobal === 0 ? null : envGlobal * 1000;
  const global = parseSeconds(config["safeguard_timeout_seconds"]);
  if (global !== undefined) return global === 0 ? null : global * 1000;
  return SAFEGUARD_DEFAULT_TIMEOUT_SECONDS * 1000;
}

/** Non-negative integer seconds, or undefined when absent/invalid. */
function parseSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export interface CappedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Cap a text payload at `maxBytes` UTF-8 bytes without splitting a
 * character. The marker makes silent truncation impossible to misread
 * as a complete report, and its bytes count AGAINST the cap, so the
 * returned text never exceeds `maxBytes` (unless the cap is smaller
 * than the marker itself, in which case the marker alone returns).
 */
export function capOutput(text: string, maxBytes: number): CappedOutput {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const marker = `\n[output truncated at ${maxBytes} bytes]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let kept = "";
  let bytes = 0;
  for (const ch of text) {
    const w = Buffer.byteLength(ch, "utf8");
    if (bytes + w > budget) break;
    kept += ch;
    bytes += w;
  }
  return { text: `${kept}${marker}`, truncated: true };
}
