/**
 * The checkpoint substrate two resume lanes share.
 *
 * `ingest/checkpoint.ts` shipped first and owned all of this privately: the
 * opt-out env var, the id validation, the location under the machine-artifact
 * directory, the read that REFUSES an unknown `schema_version` instead of
 * silently resetting, and the write that takes the sync lock, asserts vault
 * identity and lands atomically. The sessions lane now needs the same
 * discipline for a different payload - a turn boundary rather than a set of
 * completed paths - and the honest way to give it that is to extract what the
 * two share rather than copy a second, drifting version of it.
 *
 * What is shared is the MECHANISM; what is not is the record. Each lane keeps
 * its own schema, its own serializer, and its own no-op rule, because those
 * are the parts that differ: the ingest checkpoint no-ops when the completed
 * SET is unchanged, and the sessions checkpoint when the serialized bytes are.
 *
 * Why an unknown `schema_version` is a hard error in both lanes: a resume
 * point that cannot be read is not "no resume point". Treating it as one
 * would present completed work as pending, which for the sessions lane means
 * re-hashing every turn a previous run already finished - the exact cost this
 * substrate exists to avoid.
 *
 * Language-agnostic: keys are hex ids and paths; no natural-language content
 * is inspected.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { DERIVED_STORE_DIR } from "./path-constants.ts";
import { acquireLockSyncWithRetry, type LockHandle } from "./sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * Env var that, when truthy, disables checkpoint reads and writes in EVERY
 * lane. One spelling on purpose: an operator who has turned resumability off
 * for a deterministic run means it for the whole process, and a second var
 * would be a second thing to remember and a second thing to forget.
 */
export const NO_CHECKPOINT_ENV = "OSB_INGEST_NO_CHECKPOINT";

/** Shape of a checkpoint id: a lowercase hex digest prefix. */
const CHECKPOINT_ID_RE = /^[0-9a-f]{6,64}$/;

/**
 * Whether checkpointing is active. Off only when {@link NO_CHECKPOINT_ENV}
 * holds a truthy value; the empty string, `0`, and `false` are all treated as
 * unset so an accidentally-exported empty var does not silently disable
 * resumability.
 */
export function checkpointingEnabled(): boolean {
  const raw = process.env[NO_CHECKPOINT_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "0" || v === "false";
}

/**
 * Refuse an id that is not a hex digest, naming the lane. The id becomes a
 * filename, so a caller-supplied `../../etc/passwd` has to fail here rather
 * than reach `join`.
 */
export function assertCheckpointId(label: string, id: string): void {
  if (!CHECKPOINT_ID_RE.test(id)) {
    throw new Error(`invalid ${label} id (expected lowercase hex): ${JSON.stringify(id)}`);
  }
}

/** Absolute path of one checkpoint file inside a lane's own directory. */
export function checkpointFilePath(vault: string, dir: string, label: string, id: string): string {
  assertCheckpointId(label, id);
  return join(vault, DERIVED_STORE_DIR, dir, `${id}.json`);
}

/**
 * Read one checkpoint file as a plain object. Returns `null` when the file
 * does not exist. Throws - naming `label` and the path - when the bytes are
 * not JSON, are not an object, or carry a `schema_version` this build does
 * not understand. Never a silent reset.
 */
export function readCheckpointObject(
  path: string,
  label: string,
  schemaVersion: number,
): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${label} is corrupted JSON: ${path}`, { cause: e });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== schemaVersion) {
    throw new Error(
      `${label} schema_version ${String(obj["schema_version"])} not supported (expected ${schemaVersion}): ${path}`,
    );
  }
  return obj;
}

/**
 * Write one checkpoint file behind the vault-identity guard, atomically, and
 * only when the bytes differ from what is already there. Returns `true` when
 * a write happened, `false` on the byte-identical no-op - which is what keeps
 * a re-recorded boundary from touching the file's mtime.
 */
export function writeCheckpointObject(vault: string, path: string, body: string): boolean {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (existsSync(path) && readFileSync(path, "utf8") === body) return false;
  atomicWriteFileSync(path, body);
  return true;
}

/**
 * Remove one checkpoint file. Returns `true` when a file was removed, `false`
 * when there was none. Absence is the terminal state for a resume point: a
 * lane with no checkpoint starts from the beginning, which is the same thing
 * a checkpoint rewritten to empty would have to mean.
 */
export function removeCheckpointFile(vault: string, path: string): boolean {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Run `fn` with the sync lock held on a checkpoint file.
 *
 * The read, the merge and the write of a checkpoint are ONE critical section.
 * A plan's items - and a machine's session logs - are dispatched to parallel
 * workers, so two of them finishing at once would otherwise each write back
 * the state they read, and the later write would erase the earlier progress:
 * done work silently turned back into pending work on the next resume.
 */
export function withCheckpointLock<T>(path: string, fn: () => T): T {
  const handle: LockHandle = acquireLockSyncWithRetry(path);
  try {
    return fn();
  } finally {
    handle.release();
  }
}
