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
 * Scope after the store (design D14 item 13, task 2.10): this guard covers
 * vault writes. A store-only write is guarded by the store identity check
 * (`../store/store-identity.ts`, run by `storeWrite`), and the note tools
 * reach this guard through the vault adapter (`assertNoteVaultForWrite`
 * in `../vault-adapter/`), which also refuses when there is no vault.
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
 * pinned on its first write, not against an external expectation.
 *
 * ## Exactly what the guard can and cannot catch
 *
 * Stated precisely, because the previous wording implied more.
 *
 * The ONLY condition that raises {@link VaultIdentityMismatchError} is:
 * a root this process has already written to, whose marker is present
 * and now holds a DIFFERENT id than the one pinned on that first write.
 * That is the store changing underneath a live process - a profile
 * switch, a remount, a restored backup of a different vault.
 *
 * Everything else passes, by construction and not by oversight:
 *
 *   - A COLD-START MIS-RESOLUTION passes. A typo in `VAULT_DIR` yields a
 *     root with no marker, the first write pins nothing, and the write
 *     proceeds. Nothing durable records which vault the process meant,
 *     so there is no expectation to compare against; inventing one from
 *     a machine-local path would refuse every write on a synced peer.
 *     What this case gets instead is a `vault-marker-absent` notice -
 *     see {@link vaultMarkerAbsentNotice}, which the runtime-notice
 *     channel reports on any Brain tree lacking a marker.
 *   - A DELETED marker passes. Absence is indistinguishable from a fresh
 *     vault and refusing would break `o2b brain init`.
 *   - A CORRUPT marker passes, as absence, for the same reason.
 *   - TWO DISTINCT VAULTS in one process both pass. Pins are keyed by
 *     resolved root, deliberately: a CLI or MCP server legitimately
 *     serves more than one vault.
 *
 * The mechanism is therefore a same-path, same-process consistency
 * check plus a standing report on unmarked roots. It is not, and does
 * not claim to be, proof that the resolved root is the intended one.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  FileAlreadyExistsError,
} from "../fs-atomic.ts";
import { stampOfStats, stampVouches, type FileStamp } from "../fs-stamp.ts";
import { ensureInsideVault } from "../path-safety.ts";
import {
  DEGRADATION_CODE,
  degradationNotice,
  emitDegradationNotice,
  formatDegradationNotice,
  type DegradationNotice,
} from "../integrity/degradation.ts";
import { compareStamps, formatStampMismatch, type StampMismatch } from "../integrity/stamp.ts";
import { assertVaultNotFrozen, WRITE_LANE, type WriteLane } from "./freeze-marker.ts";
import { assertNoMigrationInProgress } from "../migration-gate.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";

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
  /**
   * What every machine of this vault holds alike (`vault-seed.ts`): the id
   * a missing marker gets is derived from it, so two machines that mint
   * the marker before they see each other's mint the same id, and a store
   * created from the same datum before the marker existed has the id the
   * marker leads to (`init-store.ts`). Absent: a random id.
   */
  readonly seed?: string | null;
}

/** The vault id a marker minted from `seed` carries (same form as a random one). */
export function vaultIdFromSeed(seed: string): string {
  return createHash("sha256")
    .update(`vault-id\u0000${seed}`)
    .digest("hex")
    .slice(0, VAULT_ID_BYTES * 2);
}

/**
 * Stamp the marker, or return the one already there.
 *
 * IDEMPOTENT BY CONTRACT. Re-running the bootstrap path must never mint
 * a new id: the id is what makes a synced peer's vault recognisable as
 * the same store, and rotating it on every `o2b brain init` would make
 * the identity meaningless.
 *
 * A missing marker is published exclusively (a whole temp file linked into
 * place), never by a replace: two processes that both found none may hold
 * different ids (an older log shard arrived between their seed reads), and
 * the one that publishes second gets the first one's marker back, so a
 * store created from that marker never meets a marker that names another
 * id. Only a marker file that cannot be read is replaced, as before.
 */
export function writeVaultIdentity(
  vault: string,
  opts: WriteVaultIdentityOptions = {},
): VaultIdentity {
  const existing = readVaultIdentity(vault);
  if (existing !== null) return existing;
  const identity: VaultIdentity = Object.freeze({
    schema_version: VAULT_IDENTITY_SCHEMA_VERSION,
    vault_id:
      opts.seed === undefined || opts.seed === null
        ? randomBytes(VAULT_ID_BYTES).toString("hex")
        : vaultIdFromSeed(opts.seed),
    created_at: (opts.now ?? new Date()).toISOString(),
  });
  const path = vaultIdentityPath(vault);
  const text = `${JSON.stringify(identity, null, 2)}\n`;
  try {
    atomicCreateFileSyncExclusive(path, text);
    return identity;
  } catch (err) {
    if (!(err instanceof FileAlreadyExistsError)) throw err;
  }
  // A marker is there: another process published it first, and that one
  // stands; or it cannot be read, and it is replaced, as before.
  const published = readVaultIdentity(vault);
  if (published !== null) return published;
  atomicWriteFileSync(path, text);
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
 * Stamp of the marker file the last assertion parsed, per resolved root.
 *
 * The guard sits on EVERY write, including append-heavy telemetry loops
 * that record tens of thousands of rows in one run, so the steady-state
 * cost has to be one syscall rather than an open-read-parse. The stamp
 * alone is not proof: `writeVaultIdentity` replaces the marker through a
 * temp file and a rename (a new inode), but a hand edit, a sync tool or a
 * FAT volume that reuses ids can rewrite it in place at the same size
 * inside one tick of the volume's clock, and then inode, size and both
 * times all match. `stampVouches` (`fs-stamp.ts`) therefore trusts a
 * stamp only once the marker's times are older than the read by the racy
 * window; until then, and whenever any field differs, the marker is read
 * again. A missed identity change here would let a write land in a vault
 * that is no longer the one this process pinned.
 */
interface MarkerStamp {
  readonly stamp: FileStamp;
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
  // `throwIfNoEntry: false` matters for cost, not for semantics. An
  // ABSENT marker is the steady state of every unmarked root, and this
  // function runs once per written row - so the throwing form built and
  // discarded one Error, with its stack, per append. Measured over 20k
  // guarded writes (median of 5): 159ms -> 76ms on an unmarked root,
  // unchanged on a marked one, where the stat simply succeeds and
  // nothing ever threw.
  //
  // The `catch` stays. The option suppresses ENOENT only, and every
  // other stat failure (EACCES, ELOOP) must still collapse to "absent"
  // exactly as before, rather than propagate out of a write guard.
  // Taken before the stat, so it is no later than the read of the bytes.
  const readAtMs = Date.now();
  let stat;
  try {
    // bigint: the inode compared below is exact on Windows too (NTFS ids
    // exceed 2^53; `fs-identity.ts`).
    stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    MARKER_STAMPS.delete(root);
    return null;
  }
  const cached = MARKER_STAMPS.get(root);
  if (cached !== undefined && stampVouches(cached.stamp, stat)) {
    return cached.vaultId;
  }
  const identity = readVaultIdentity(root);
  if (identity === null) {
    MARKER_STAMPS.delete(root);
    return null;
  }
  MARKER_STAMPS.set(root, { stamp: stampOfStats(stat, readAtMs), vaultId: identity.vault_id });
  return identity.vault_id;
}

/**
 * The `vault-marker-absent` notice for `vault`, or `null` when the
 * resolved root carries a readable marker.
 *
 * This is the READ-SIDE half of the unit, and the only place the absent
 * branch is described. Two callers exist and they need the same record
 * for different reasons: {@link assertVaultIdentityForWrite} emits it
 * into a write-path sink, and the diagnostic surfaces report it as a
 * standing condition of the root.
 *
 * A corrupt or unparseable marker reads as ABSENT here, exactly as it
 * does in {@link readVaultIdentity}: the two cannot be distinguished
 * without guessing, and guessing wrong turns a truncated sync into a
 * refusal.
 */
export function vaultMarkerAbsentNotice(vault: string): DegradationNotice | null {
  const root = resolve(vault);
  if (currentVaultId(root) !== null) return null;
  return degradationNotice({
    code: DEGRADATION_CODE.vaultMarkerAbsent,
    site: SITE,
    path: root,
    detail:
      "resolved vault root carries no identity marker; " +
      "run `o2b brain init` on this root if it is the intended vault",
  });
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
 *
 * ## The freeze rides here, and why here rather than at the note seam
 *
 * `lane` selects which half of the write surface the caller belongs to
 * (who-wrote-what, Task C). The default, {@link WRITE_LANE.content},
 * refuses while `Brain/.state/frozen.json` exists - and it is checked
 * FIRST, ahead of the identity comparison, because a frozen vault is a
 * decision an operator made and an identity mismatch is a condition they
 * have not seen yet; reporting the second while the first holds would
 * answer a question nobody asked.
 *
 * This guard is the freeze's seam because it is the only position every
 * content writer already passes. It is the migration gate's seam for the
 * same reason, on both lanes and ahead of the freeze: the gate holds the
 * audit lane too. Hooking the note-write seam instead
 * would have left the dream pass, hygiene, page-dedup and the
 * write-session engine writing preferences, signals and state straight
 * through a freeze.
 */
export function assertVaultIdentityForWrite(
  vault: string,
  sink?: DegradationNotice[],
  lane: WriteLane = WRITE_LANE.content,
): void {
  const root = resolve(vault);
  // A brain store migration of this vault holding this machine's gate
  // (design D11 step 2) refuses EVERY write, on both lanes. The audit lane
  // exists so a freeze does not silence its own record; a migration has no
  // such need, and a log line, a freeze marker or an attestation written
  // into the legacy tree while it is being moved is a write the migration
  // may never carry over (a record after its last pass, or into a surface
  // it copied once). The run's own snapshot passes through
  // `asMigrationGateHolder`, nothing else does.
  assertNoMigrationInProgress(root);
  if (lane === WRITE_LANE.content) assertVaultNotFrozen(root);
  const vaultId = currentVaultId(root);
  if (vaultId === null) {
    if (sink !== undefined) {
      const absent = vaultMarkerAbsentNotice(root);
      // `currentVaultId` just reported no readable marker, so the notice
      // is non-null; the check keeps the types honest rather than casting.
      if (absent !== null) emitDegradationNotice(sink, absent);
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
