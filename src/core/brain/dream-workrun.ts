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
 * A store-only machine (design D14 items 1 and 11) keeps its workruns in
 * device-local state, never under the vault: they are forensic evidence
 * of this machine's own process, which no other machine needs to agree
 * on, so they are not a store ledger ({@link workrunDir}).
 *
 * Writes use `appendFileSync` on the same file. The OS guarantees
 * `O_APPEND` is atomic for small writes (under PIPE_BUF, 4096 bytes
 * on Linux); each JSONL line is ~120 bytes so a partial write would
 * be deeply pathological. We do not fsync per phase - a crash that
 * loses the last phase line is acceptable (the file is still flagged
 * dangling on the next scan).
 */

import { BRAIN_LOG_REL } from "./path-constants.ts";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";

import { isMachineStateRelocated, machineStatePath } from "../state/machine-state.ts";
import { dreamRunsDir, dreamWorkrunPath, validateRunId } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * Where this machine keeps its workruns: `Brain/log/dream-runs/` on an
 * unswitched machine, the same vault-relative path in its device-local
 * machine state (`machineStatePath`) on a store-only one. The migration
 * drops the legacy workruns, so this is their one location.
 */
export function workrunDir(vault: string | null): string {
  return machineStatePath(vault, dreamRunsRel(vault));
}

/** The vault-relative workrun folder (`Brain/log/dream-runs`), with or without a vault. */
function dreamRunsRel(vault: string | null): string {
  return vault === null ? DREAM_RUNS_REL : relative(vault, dreamRunsDir(vault));
}

/** The workrun folder under `Brain/`, as machine state names it with no vault. */
const DREAM_RUNS_REL = posix.join(BRAIN_LOG_REL, "dream-runs");

/** The workrun file of `runId` in {@link workrunDir}; the run id is validated. */
export function workrunPath(vault: string | null, runId: string): string {
  if (vault !== null && !isMachineStateRelocated(vault)) return dreamWorkrunPath(vault, runId);
  return machineStatePath(vault, dreamRunsRel(vault), `${validateRunId(runId)}.jsonl`);
}

/**
 * Canonical phase identifiers. Nine forward-progress phases plus the
 * sticky `interrupted` terminal. Readers MUST tolerate unknown future
 * phases.
 *
 * Emission order is EXECUTION order, not the order declared here and not
 * `DREAM_PHASE_ORDER` (which is the reporting order of the summary). A
 * marker is written at the point where that phase's durable output has
 * landed, so `reconcile_complete` trails `heal_complete`: reconcile's only
 * artifacts are audit events written in the log phase. See the emission
 * notes in `dream.ts`.
 */
export const WORKRUN_PHASE = Object.freeze({
  started: "started",
  clusterComplete: "cluster_complete",
  promoteComplete: "promote_complete",
  retireComplete: "retire_complete",
  finalized: "finalized",
  interrupted: "interrupted",
  // Brain lifecycle suite (Feature 2): multi-phase dream checkpoints.
  // Emitted between `started` and `finalized`, each where its phase's
  // writes land. Readers tolerate unknown phases.
  closeComplete: "close_complete",
  reconcileComplete: "reconcile_complete",
  synthesizeComplete: "synthesize_complete",
  healComplete: "heal_complete",
} as const);

export type WorkrunPhase = (typeof WORKRUN_PHASE)[keyof typeof WORKRUN_PHASE];

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
export function openWorkrun(vault: string | null, runId: string): WorkrunHandle {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  if (vault !== null && !isMachineStateRelocated(vault)) assertVaultIdentityForWrite(vault);
  const path = workrunPath(vault, runId);
  mkdirSync(dirname(path), { recursive: true });
  let closed = false;
  const append = (phase: WorkrunPhase, extra: Record<string, unknown> = {}): void => {
    const line =
      JSON.stringify({
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
      append(WORKRUN_PHASE.interrupted, reason !== undefined ? { reason } : {});
    },
  };
}

/**
 * Walk `Brain/log/dream-runs/` and return the paths of every workrun
 * whose last event is neither `finalized` nor `interrupted`. A
 * corrupt / unparseable file is treated as dangling so the operator
 * sees it.
 */
export function scanDanglingWorkruns(vault: string | null): string[] {
  const dir = workrunDir(vault);
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
      if (parsed.phase !== WORKRUN_PHASE.finalized && parsed.phase !== WORKRUN_PHASE.interrupted) {
        out.push(path);
      }
    } catch {
      out.push(path);
    }
  }
  return out;
}
