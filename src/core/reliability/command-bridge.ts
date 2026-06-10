/**
 * Shared external-command JSON bridge (continuity-hygiene-freshness
 * suite).
 *
 * The Brain core stays deterministic: no LLM (or any other external
 * judgment) ever runs inside the harness. When a feature wants an
 * external opinion - the bench judge, the hygiene conflict resolver -
 * it goes through this one boundary: a configured shell command
 * receives the question as JSON on stdin and answers with JSON on
 * stdout. The bridge is advisory and fail-open by contract: an absent
 * command skips, and every failure mode (non-zero exit, signal kill,
 * timeout, malformed JSON) reports `error` instead of throwing, so a
 * broken bridge can never take down the deterministic path around it.
 */

import { spawnSync } from "node:child_process";

export interface JsonCommandBridgeOptions {
  /** Kill the command after this many milliseconds (default 60s). */
  readonly timeoutMs?: number;
  /** Noun used in error details, e.g. "judge command" (default "command"). */
  readonly label?: string;
}

export type JsonCommandBridgeResult =
  | { readonly status: "skipped" }
  | { readonly status: "ran"; readonly output: unknown }
  | { readonly status: "error"; readonly detail: string };

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run `cmd` through `sh -c` with `input` serialized as JSON on stdin
 * and parse its stdout as JSON. Never throws.
 */
export function runJsonCommandBridge(
  cmd: string | undefined,
  input: unknown,
  opts: JsonCommandBridgeOptions = {},
): JsonCommandBridgeResult {
  if (cmd === undefined || cmd.trim() === "") return Object.freeze({ status: "skipped" });
  const label = opts.label ?? "command";
  try {
    const proc = spawnSync("sh", ["-c", cmd], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (proc.status !== 0) {
      return Object.freeze({
        status: "error",
        detail: `${label} exited ${proc.status ?? "by signal"}`,
      });
    }
    return Object.freeze({ status: "ran", output: JSON.parse(proc.stdout) as unknown });
  } catch (error) {
    return Object.freeze({
      status: "error",
      detail: error instanceof Error ? error.message : `${label} failed`,
    });
  }
}
