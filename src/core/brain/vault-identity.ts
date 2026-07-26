/**
 * Unit J - vault identity marker, read, write, and comparison.
 *
 * `resolveVault` has five branches and four of them return a path with
 * ZERO existence validation: the `VAULT_DIR` env var, the active
 * profile, and the config `vault:` key are taken at face value, and the
 * pointer branch stats but fails soft. Every Brain write then funnels
 * through `brainDirs` - a containment check only - into `withTempFile`,
 * which calls `mkdirSync(dir, {recursive: true})`. The consequence is
 * that the FIRST WRITE materializes a mis-resolved root: a typo in
 * `VAULT_DIR` does not fail, it creates a second, empty memory store
 * that looks exactly like a vault where nothing has been recorded yet.
 *
 * This module supplies the identity that makes such a root nameable.
 *
 * ## Absent WARNS, present-and-different REFUSES
 *
 * The two conditions are not symmetric and must not be treated alike.
 *
 *   - An ABSENT marker is ambiguous by construction. A fresh directory,
 *     a vault predating markers, and a completely wrong root all look
 *     identical, and refusing would break `o2b brain init` on the very
 *     path it exists to serve. So absence is reported as a
 *     `vault-marker-absent` notice and the write proceeds.
 *   - A marker that is PRESENT and does not match what this process has
 *     already been writing to is unambiguous: the store under this path
 *     is not the store the process started with. That refuses.
 *
 * Because the condition is binary, no gate mode is involved. Units whose
 * condition is genuinely environment-dependent (the embedding ABI, the
 * owner-scope delivery filter) carry modes; this one does not.
 *
 * ## The marker carries NO absolute path
 *
 * A vault is Syncthing-shared across devices, so any machine-local
 * absolute path stored inside it is stale on every peer. A marker
 * recording where it was written would therefore refuse every write on
 * the second device - the exact class of defect this repository already
 * names for index keys. The marker records only an opaque random id, so
 * it is identical on every peer and survives a `mv` of the vault.
 *
 * The comparison is consequently against the identity THIS PROCESS
 * pinned on its first write, not against an external expectation. That
 * catches the store changing underneath a live process - a profile
 * switch, a remount, a restored backup of a different vault - which is
 * precisely a write landing somewhere other than where the process
 * believes it is writing. A cold-start mis-resolution lands in the
 * absent-marker branch above and is surfaced by the doctor.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import {
  DEGRADATION_CODE,
  degradationNotice,
  emitDegradationNotice,
  formatDegradationNotice,
  type DegradationNotice,
} from "../integrity/degradation.ts";
import { compareStamps, formatStampMismatch, type StampMismatch } from "../integrity/stamp.ts";
import { BRAIN_ROOT_REL } from "./paths.ts";

/** Marker schema version. Bumped only on an incompatible field change. */
export const VAULT_IDENTITY_SCHEMA_VERSION = 1;

/** Marker filename inside `Brain/`. */
export const VAULT_IDENTITY_FILE = "vault-id.json";

/** Site name carried by every notice this module emits. */
const SITE = "vault-identity";

/** Stamp field name shared by the notice and the mismatch record. */
const VAULT_ID_FIELD = "vault_id";

/** Bytes of entropy behind a vault id (rendered as 32 hex characters). */
const VAULT_ID_BYTES = 16;

/**
 * A vault's durable identity. Deliberately minimal: an opaque id and
 * when it was minted. Nothing here is machine-local, so the record is
 * byte-identical on every synced peer.
 */
export interface VaultIdentity {
  readonly schema_version: number;
  readonly vault_id: string;
  readonly created_at: string;
}

/** Path of the identity marker: `<vault>/Brain/vault-id.json`. */
export function vaultIdentityPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_ROOT_REL, VAULT_IDENTITY_FILE), vault);
}

/**
 * Read the marker, or `null` when there is none.
 *
 * An unreadable or malformed marker also reads as `null` - that is, as
 * ABSENT rather than as a mismatch. Treating corruption as a mismatch
 * would refuse writes on a truncated sync, which is the failure mode a
 * warn-on-absence design exists to avoid.
 */
export function readVaultIdentity(vault: string): VaultIdentity | null {
  const path = vaultIdentityPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VaultIdentity>;
    if (typeof parsed.vault_id !== "string" || parsed.vault_id.length === 0) return null;
    return Object.freeze({
      schema_version:
        typeof parsed.schema_version === "number"
          ? parsed.schema_version
          : VAULT_IDENTITY_SCHEMA_VERSION,
      vault_id: parsed.vault_id,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
    });
  } catch {
    return null;
  }
}

export interface WriteVaultIdentityOptions {
  /** Clock for `created_at`; injected so a test can pin the stamp. */
  readonly now?: Date;
}

/**
 * Stamp the marker, or return the one already there.
 *
 * IDEMPOTENT BY CONTRACT. Re-running the bootstrap path must never mint
 * a new id: the id is what makes a synced peer's vault recognisable as
 * the same store, and rotating it on every `o2b brain init` would make
 * the identity meaningless.
 */
export function writeVaultIdentity(
  vault: string,
  opts: WriteVaultIdentityOptions = {},
): VaultIdentity {
  const existing = readVaultIdentity(vault);
  if (existing !== null) return existing;
  const identity: VaultIdentity = Object.freeze({
    schema_version: VAULT_IDENTITY_SCHEMA_VERSION,
    vault_id: randomBytes(VAULT_ID_BYTES).toString("hex"),
    created_at: (opts.now ?? new Date()).toISOString(),
  });
  atomicWriteFileSync(vaultIdentityPath(vault), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

/**
 * A write was attempted against a root whose recorded identity is not
 * the one this process has been writing to. Carries the structured
 * notice and the stamp mismatch behind the message so a caller can
 * report the evidence rather than re-parse the string.
 */
export class VaultIdentityMismatchError extends Error {
  readonly notice: DegradationNotice;
  readonly mismatch: StampMismatch;

  constructor(notice: DegradationNotice, mismatch: StampMismatch) {
    super(formatDegradationNotice(notice));
    this.name = "VaultIdentityMismatchError";
    this.notice = notice;
    this.mismatch = mismatch;
  }
}

/**
 * Identity this process pinned per resolved root, on its first write.
 *
 * Module state is the right scope: the question the guard answers is
 * "is this still the store I have been writing to?", which is a
 * property of the running process and of nothing durable. Keying by the
 * resolved path keeps two roots in one process independent.
 */
const PINNED_IDENTITIES = new Map<string, string>();

/**
 * Inode identity of the marker file the last assertion parsed, per
 * resolved root.
 *
 * The guard sits on EVERY write, including append-heavy telemetry loops
 * that record tens of thousands of rows in one run, so the per-call cost
 * has to be one syscall rather than an open-read-parse. `writeVaultIdentity`
 * goes through `atomicWriteFileSync` - a temp file plus a rename - so a
 * replaced marker always arrives with a new inode. Matching on
 * (inode, size, mtime) therefore proves the bytes are the ones already
 * parsed; anything else falls through to a full re-read.
 */
interface MarkerStamp {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly vaultId: string;
}
const MARKER_STAMPS = new Map<string, MarkerStamp>();

/** Resolved marker path per root; see {@link currentVaultId}. */
const MARKER_PATHS = new Map<string, string>();

/**
 * Drop every pin. Exported for tests, which run many vaults in one
 * process; production code has no reason to call it.
 */
export function resetVaultIdentityPins(): void {
  PINNED_IDENTITIES.clear();
  MARKER_STAMPS.clear();
  MARKER_PATHS.clear();
}

/**
 * The marker's `vault_id`, re-read only when the file on disk is not
 * byte-for-byte the one the last call parsed. `null` for absent,
 * unreadable, or malformed - the same collapse {@link readVaultIdentity}
 * performs, for the same reason.
 */
function currentVaultId(root: string): string | null {
  // `vaultIdentityPath` runs the full containment check (lexical plus a
  // realpath walk of the deepest existing ancestor). That is the right
  // price once per root and the wrong price once per appended row, so
  // the resolved path is memoized alongside the marker stamp.
  let path = MARKER_PATHS.get(root);
  if (path === undefined) {
    path = vaultIdentityPath(root);
    MARKER_PATHS.set(root, path);
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    MARKER_STAMPS.delete(root);
    return null;
  }
  const cached = MARKER_STAMPS.get(root);
  if (
    cached !== undefined &&
    cached.ino === stat.ino &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    return cached.vaultId;
  }
  const identity = readVaultIdentity(root);
  if (identity === null) {
    MARKER_STAMPS.delete(root);
    return null;
  }
  MARKER_STAMPS.set(root, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    vaultId: identity.vault_id,
  });
  return identity.vault_id;
}

/**
 * Assert that a write may proceed against `vault`.
 *
 * Emits a `vault-marker-absent` notice into `sink` (when one is given)
 * for an unmarked root and returns; throws
 * {@link VaultIdentityMismatchError} when the root's marker differs from
 * the one this process pinned. Never throws for an absent, unreadable,
 * or malformed marker.
 *
 * ## Two call surfaces, one assertion
 *
 * Brain writers reach the vault tree two ways, and both funnel here.
 *
 *   - Writers that resolve a whole directory set call
 *     `brainDirsForWrite`, which is a thin wrapper over this function.
 *   - Writers that build a single path with one of the `paths.ts`
 *     builders (`preferencePath`, `entityPath`, `decisionPath`, …) call
 *     this function DIRECTLY, at their own entry point.
 *
 * The second surface exists because the builders are intent-neutral by
 * construction: `preferencePath` serves `parsePreference` and
 * `writePreference` alike, so asserting inside the builder would refuse
 * reads. The assertion therefore belongs to the writer, and it belongs
 * BEFORE the writer's first byte - a refusal that arrives after the page
 * is on disk has already materialized the wrong store.
 */
export function assertVaultIdentityForWrite(vault: string, sink?: DegradationNotice[]): void {
  const root = resolve(vault);
  const vaultId = currentVaultId(root);
  if (vaultId === null) {
    if (sink !== undefined) {
      emitDegradationNotice(sink, {
        code: DEGRADATION_CODE.vaultMarkerAbsent,
        site: SITE,
        path: root,
        detail:
          "resolved vault root carries no identity marker; " +
          "run `o2b brain init` on this root if it is the intended vault",
      });
    }
    return;
  }

  const pinned = PINNED_IDENTITIES.get(root);
  if (pinned === undefined) {
    PINNED_IDENTITIES.set(root, vaultId);
    return;
  }
  if (pinned === vaultId) return;

  const mismatch = compareStamps({ [VAULT_ID_FIELD]: pinned }, { [VAULT_ID_FIELD]: vaultId })[0];
  // compareStamps reports every differing field and the two ids differ,
  // so exactly one mismatch is guaranteed here.
  const evidence = mismatch as StampMismatch;
  throw new VaultIdentityMismatchError(
    degradationNotice({
      code: DEGRADATION_CODE.vaultMarkerMismatch,
      site: SITE,
      path: root,
      detail: `refusing to write: the store at this root is not the one this process opened (${formatStampMismatch(evidence)})`,
    }),
    evidence,
  );
}
