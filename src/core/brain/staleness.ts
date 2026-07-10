/**
 * Materialize-freshness staleness gate (Ingestion & Import Robustness suite,
 * t_845fe240).
 *
 * A deterministic refresh that materializes outputs from inputs (e.g. the
 * clusters pass writes `Brain/clusters/` from the vault's notes) can be a
 * no-op when the outputs are already newer than every input. This primitive
 * answers that mtime question so an agent can invoke the refresh cheaply at the
 * start of graph work - the expensive recompute runs only when an input
 * actually changed.
 *
 * mtime-based by design: the gate is an OPT-IN fast-path (`--if-stale`), and
 * the `>=` comparison errs toward recompute (an input strictly newer than the
 * oldest output is stale). A missing/unreadable path contributes no mtime
 * rather than being treated as infinitely new, so a transient stat failure
 * never forces a needless recompute.
 *
 * Language-agnostic: only filesystem mtimes are compared; no content is read.
 */

import { statSync } from "node:fs";

export interface StalenessResult {
  /** True when outputs exist and every output is at least as new as every input. */
  readonly fresh: boolean;
  /** Newest input mtime in ms, or null when no input has a readable mtime. */
  readonly newestInputMs: number | null;
  /** Oldest output mtime in ms, or null when no output exists/reads. */
  readonly oldestOutputMs: number | null;
}

/** File mtime in ms, or null when the path is missing or unreadable. */
export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Evaluate whether materialized `outputs` are fresh with respect to `inputs`.
 *
 * Fresh iff at least one output has a readable mtime AND the oldest output
 * mtime is >= the newest input mtime. With no outputs the result is never
 * fresh (nothing has been materialized yet); with outputs but no readable
 * inputs it is fresh (there is nothing that could have changed).
 */
export function evaluateStaleness(
  inputs: readonly string[],
  outputs: readonly string[],
): StalenessResult {
  const inputMs = inputs.map(mtimeMs).filter((m): m is number => m !== null);
  const outputMs = outputs.map(mtimeMs).filter((m): m is number => m !== null);

  const newestInputMs = inputMs.length > 0 ? Math.max(...inputMs) : null;
  if (outputMs.length === 0) {
    return Object.freeze({ fresh: false, newestInputMs, oldestOutputMs: null });
  }
  const oldestOutputMs = Math.min(...outputMs);
  const fresh = newestInputMs === null || oldestOutputMs >= newestInputMs;
  return Object.freeze({ fresh, newestInputMs, oldestOutputMs });
}
