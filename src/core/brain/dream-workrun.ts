/**
 * Durable workrun checkpoints for the dream pass (Brain Integrity
 * Suite Feature 4).
 *
 * Each dream invocation opens a JSONL workrun file under
 * `Brain/log/dream-runs/<run-id>.jsonl` and records one line per
 * phase transition (`started`, `cluster_complete`, `promote_complete`,
 * `retire_complete`, `finalized` | `interrupted`). A crash mid-pass
 * leaves an inspectable trail; the next invocation calls
 * {@link scanDanglingWorkruns} on startup to find any run that did
 * not reach `finalized` / `interrupted`. Recovery is non-resuming -
 * the next dream pass processes the inbox fresh; the dangling file
 * serves as forensic evidence, not a resumable state machine.
 *
 * Dry-run never opens a workrun: dryRun must not mutate disk.
 *
 * Writes use `appendFileSync` on the same file. The OS guarantees
 * `O_APPEND` is atomic for small writes (under PIPE_BUF, 4096 bytes
 * on Linux); each JSONL line is ~120 bytes so a partial write would
 * be deeply pathological. We do not fsync per phase - a crash that
 * loses the last phase line is acceptable (the file is still flagged
 * dangling on the next scan).
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  dreamRunsDir,
  dreamWorkrunPath,
} from "./paths.ts";

/**
 * Canonical phase identifiers. Five forward-progress phases plus the
 * sticky `interrupted` terminal. The dream pass emits them in the
 * order declared; readers MUST tolerate unknown future phases.
 */
export const WORKRUN_PHASE = Object.freeze({
  started: "started",
  clusterComplete: "cluster_complete",
  promoteComplete: "promote_complete",
  retireComplete: "retire_complete",
  finalized: "finalized",
  interrupted: "interrupted",
} as const);

export type WorkrunPhase =
  (typeof WORKRUN_PHASE)[keyof typeof WORKRUN_PHASE];

export interface WorkrunHandle {
  /** Path of the underlying JSONL file. */
  readonly path: string;
  /** Append one checkpoint line. Silent no-op after finalize/interrupt. */
  checkpoint(phase: WorkrunPhase, payload?: Record<string, unknown>): void;
  /** Append the terminal `finalized` line. Idempotent. */
  finalize(): void;
  /** Append a terminal `interrupted` line with optional reason. Idempotent. */
  interrupt(reason?: string): void;
}

/**
 * Open a workrun for `runId`, immediately writing the `started`
 * phase. Creates the workrun directory on demand.
 */
export function openWorkrun(vault: string, runId: string): WorkrunHandle {
  const path = dreamWorkrunPath(vault, runId);
  mkdirSync(dirname(path), { recursive: true });
  let closed = false;
  const append = (phase: WorkrunPhase, extra: Record<string, unknown> = {}): void => {
    const line = JSON.stringify({
      phase,
      at: new Date().toISOString(),
      run_id: runId,
      ...extra,
    }) + "\n";
    appendFileSync(path, line, "utf8");
  };
  append(WORKRUN_PHASE.started);
  return {
    path,
    checkpoint(phase: WorkrunPhase, payload: Record<string, unknown> = {}): void {
      if (closed) return;
      append(phase, payload);
    },
    finalize(): void {
      if (closed) return;
      closed = true;
      append(WORKRUN_PHASE.finalized);
    },
    interrupt(reason?: string): void {
      if (closed) return;
      closed = true;
      append(
        WORKRUN_PHASE.interrupted,
        reason !== undefined ? { reason } : {},
      );
    },
  };
}

/**
 * Walk `Brain/log/dream-runs/` and return the paths of every workrun
 * whose last event is neither `finalized` nor `interrupted`. A
 * corrupt / unparseable file is treated as dangling so the operator
 * sees it.
 */
export function scanDanglingWorkruns(vault: string): string[] {
  const dir = dreamRunsDir(vault);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    // Skip non-regular files (a directory named `*.jsonl` would
    // otherwise be reported as dangling on the very first readFileSync
    // failure). lstat ignores symlinks the same way.
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    try {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        out.push(path);
        continue;
      }
      const last = lines[lines.length - 1]!;
      let parsed: { phase?: unknown };
      try {
        parsed = JSON.parse(last) as { phase?: unknown };
      } catch {
        out.push(path);
        continue;
      }
      if (
        parsed.phase !== WORKRUN_PHASE.finalized &&
        parsed.phase !== WORKRUN_PHASE.interrupted
      ) {
        out.push(path);
      }
    } catch {
      out.push(path);
    }
  }
  return out;
}
