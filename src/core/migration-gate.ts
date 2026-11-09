/**
 * The device-local migration gate (design D11 step 2). While a brain
 * store migration runs on this machine, the gate file in the device-local
 * state (`<state base>/open-second-brain/migration-gate.json`, never
 * synced) names the vault it migrates, and every content writer on this
 * machine refuses with a migration-in-progress message
 * ({@link assertNoMigrationInProgress}, called from the vault-identity
 * write guard every content writer passes).
 *
 * It replaces the vault freeze marker for the migration because that
 * marker syncs: other machines keep writing during a migration here, and
 * their writes reach the store through the delta pass and the transition
 * import.
 *
 * The gate is one small JSON file, read once per content write (a missing
 * file is one failed open). Vaults are compared by their real path, case
 * folded on Windows, so a writer reaching the vault by another spelling
 * (a link, a junction, another drive-letter case) is refused too.
 */

import { mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { atomicWriteFileSync, sleepSync } from "./fs-atomic.ts";
import { processDirsEnv, stateRootDir, type PlatformDirsEnv } from "./platform-dirs.ts";

/** What the gate file holds. */
export interface MigrationGate {
  /** Resolved path of the vault being migrated. */
  readonly vault: string;
  readonly run_id: string;
  readonly since: string;
  /** Process id of the run holding the gate. */
  readonly pid: number;
  /**
   * The start identity of that process (`store-migration/process-identity.ts`),
   * so a pid reused by an unrelated process is told apart from the holder.
   * Absent in a gate written by an older release.
   */
  readonly started?: string;
}

const GATE_FILE = "migration-gate.json";

/** The command that continues an interrupted migration, which also lifts the gate. */
export const MIGRATION_GATE_NEXT_COMMAND = "o2b brain migrate-store --resume";

/** A content write refused because a migration of its vault is running here. */
export class MigrationInProgressError extends Error {
  override readonly name = "MigrationInProgressError";
  readonly next_command = MIGRATION_GATE_NEXT_COMMAND;
  constructor(readonly gate: MigrationGate) {
    super(
      `a brain store migration of this vault is in progress on this machine (run ${gate.run_id}, ` +
        `since ${gate.since}); the write was refused and nothing was written. Try again when ` +
        "`o2b brain migrate-store` has finished, or resume an interrupted one with `--resume`",
    );
  }
}

export function migrationGatePath(source: PlatformDirsEnv = processDirsEnv()): string {
  return join(stateRootDir(source), GATE_FILE);
}

/**
 * The form two spellings of one vault share: its real path (links and
 * junctions resolved), case folded on Windows, where `C:\Vault` and
 * `c:\vault` are one folder. A path that cannot be resolved keeps its
 * resolved spelling.
 */
export function canonicalVault(vault: string): string {
  let path: string;
  try {
    path = realpathSync(vault);
  } catch {
    path = resolve(vault);
  }
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Whether the gate names `vault`, however either was spelled. */
function gateNames(gate: MigrationGate, vault: string): boolean {
  return canonicalVault(gate.vault) === canonicalVault(vault);
}

/**
 * What the gate file says: no gate, a gate, a damaged gate (it was read
 * but is not a gate: the migration is its remedy), or a gate that exists
 * and could not be read even after a few short retries (a sharing
 * violation while another run rewrites it: it may be live, so it is never
 * taken over or released on that read).
 */
export type MigrationGateState =
  | { readonly kind: "none" }
  | { readonly kind: "held"; readonly gate: MigrationGate }
  | { readonly kind: "damaged" }
  | { readonly kind: "unreadable"; readonly code: string };

/** Attempts and pause of a gate read that hits an I/O failure. */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 25;

/** Read and classify the gate file (see {@link MigrationGateState}). */
export function readMigrationGateState(source?: PlatformDirsEnv): MigrationGateState {
  const path = migrationGatePath(source);
  let text: string | null = null;
  let code = "";
  for (let attempt = 0; attempt < READ_ATTEMPTS && text === null; attempt++) {
    if (attempt > 0) sleepSync(READ_RETRY_MS);
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      // Released between a check and the read, or never held: not held.
      code = String((err as NodeJS.ErrnoException).code ?? "EIO");
      if (code === "ENOENT") return { kind: "none" };
    }
  }
  if (text === null) return { kind: "unreadable", code };
  try {
    const parsed = JSON.parse(text) as Partial<MigrationGate>;
    if (typeof parsed.vault === "string" && typeof parsed.run_id === "string") {
      return {
        kind: "held",
        gate: {
          vault: parsed.vault,
          run_id: parsed.run_id,
          since: typeof parsed.since === "string" ? parsed.since : "",
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          ...(typeof parsed.started === "string" ? { started: parsed.started } : {}),
        },
      };
    }
  } catch {
    // fall through: not a gate
  }
  return { kind: "damaged" };
}

/** The gate, or null when no migration holds it (an unreadable gate counts as held). */
export function readMigrationGate(source?: PlatformDirsEnv): MigrationGate | null {
  const state = readMigrationGateState(source);
  if (state.kind === "none") return null;
  return state.kind === "held" ? state.gate : UNREADABLE_GATE;
}

const UNREADABLE_GATE: MigrationGate = Object.freeze({
  vault: "",
  run_id: "unknown",
  since: "",
  pid: 0,
});

/** A migration asked for the gate while a migration of another vault holds it. */
export class MigrationGateHeldError extends Error {
  override readonly name = "MigrationGateHeldError";
  /** With `readError`, the gate file exists and could not be read (that code). */
  constructor(
    readonly gate: MigrationGate,
    readError?: string,
  ) {
    super(
      readError === undefined
        ? `another brain store migration holds this machine's migration gate (run ${gate.run_id}, ` +
            `since ${gate.since}); let it finish, or resume it with \`${MIGRATION_GATE_NEXT_COMMAND}\``
        : `this machine's migration gate ${migrationGatePath()} cannot be read (${readError}); ` +
            "nothing was changed. Try again in a moment",
    );
  }
}

/**
 * Hold the gate for `vault` and run `runId`, recording `started`, the start
 * identity of this process, when it is known. A gate already held for the
 * same vault is taken over (a resumed run, or the rollback of an
 * interrupted one, re-holds what the last run left); a gate held for
 * another vault is refused with a {@link MigrationGateHeldError}, so one
 * run never lifts another's protection. A damaged gate is replaced: the
 * migration is its remedy. A gate that cannot be read at all is refused
 * too: it may be another run's live gate.
 */
export function holdMigrationGate(
  vault: string,
  runId: string,
  started: string | null = null,
): void {
  const state = readMigrationGateState();
  if (state.kind === "unreadable") throw new MigrationGateHeldError(UNREADABLE_GATE, state.code);
  if (state.kind === "held" && !gateNames(state.gate, vault)) {
    throw new MigrationGateHeldError(state.gate);
  }
  const path = migrationGatePath();
  mkdirSync(dirname(path), { recursive: true });
  const gate: MigrationGate = {
    vault: resolve(vault),
    run_id: runId,
    since: new Date().toISOString(),
    pid: process.pid,
    ...(started === null ? {} : { started }),
  };
  atomicWriteFileSync(path, `${JSON.stringify(gate, null, 2)}\n`);
}

/**
 * Release the gate when it is held for `vault` by the run `runId`: a run
 * removes only its own gate, never one a later run took over. A damaged
 * gate is released by any run on any vault; a gate that cannot be read is
 * left in place (it may be another run's live gate).
 */
export function releaseMigrationGate(vault: string, runId: string): void {
  const state = readMigrationGateState();
  if (state.kind === "none" || state.kind === "unreadable") return;
  if (state.kind === "held" && (!gateNames(state.gate, vault) || state.gate.run_id !== runId)) {
    return;
  }
  try {
    unlinkSync(migrationGatePath());
  } catch {
    // already gone
  }
}

/**
 * Refuse a content write to `vault` while a migration of it runs on this
 * machine. An unreadable gate refuses every vault (fails closed).
 */
export function assertNoMigrationInProgress(vault: string): void {
  const gate = readMigrationGate();
  if (gate === null) return;
  if (gate.vault === "" || gateNames(gate, vault)) throw new MigrationInProgressError(gate);
}
