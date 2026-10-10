/**
 * Passphrase-wrapped keyfile envelope (t_e6667a56).
 *
 * The raw 32-byte DEK at the keyfile path can be replaced by a versioned
 * scrypt envelope that only a passphrase unwraps. Opt-in by action, not by
 * config: the presence of an envelope at the keyfile path is the state, and
 * an unwrapped store needs no flag and behaves byte-identically to before.
 *
 * The KDF is scrypt from node:crypto with explicit, stored parameters
 * (N = 2^15, r = 8, p = 1, 32-byte output, a fresh random 16-byte salt per
 * envelope, maxmem set explicitly) so they can migrate without breaking old
 * stores; an unknown algo or version refuses by name. Wrong-passphrase
 * detection is free and fail-closed: the GCM authentication tag over the
 * wrapped DEK throws. `timingSafeEqual` guards the one comparison between
 * two pieces of derived key material this module makes (the holder-
 * consistency check at re-unlock).
 *
 * The unlocked DEK lives ONLY in a process-local, memory-only holder in
 * this module. There is no daemon: every CLI invocation and the MCP server
 * unlock separately, `lock` clears this process's holder, and a second
 * context over the same vault gets the named locked-store refusal. The
 * one cross-process bridge is the environment: a host launched with
 * `OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE` set unwraps with it at the first
 * key operation, holds the DEK, and deletes the variable, so a
 * non-interactive host that cannot answer a prompt still reaches its
 * wrapped store. The passphrase itself is never persisted, logged, or
 * audited.
 *
 * Honest warning, stated here because there is no recovery path and none
 * is pretended: a lost passphrase makes every stored secret permanently
 * unreadable. Against a root or same-user attacker nothing here helps -
 * the threat model in `crypto.ts` is unchanged.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { atomicWriteText, renameWithRetry } from "../../fs-atomic.ts";
import { type EncryptedValue, decryptValue, encryptValue } from "./value-cipher.ts";
import { restrictToOwner } from "./owner-acl.ts";

/** Envelope schema version. Bumped only on an incompatible field change. */
export const KEYFILE_ENVELOPE_SCHEMA_VERSION = 1;

const KDF_ALGO = "scrypt";
/** Length of the passphrase-derived wrap key (AES-256). */
const WRAP_KEY_BYTES = 32;
/** Length of the DEK the envelope wraps (the raw keyfile's size). */
const DEK_BYTES = 32;
const SALT_BYTES = 16;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// 128 * N * r is the memory scrypt needs for these parameters; the default
// ceiling sits exactly at that line, so the headroom is set explicitly.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/**
 * The cost CEILING this build accepts from a stored envelope or bundle.
 * The stored parameters are honored (not re-derived) - that is what makes
 * migration possible - but honored UNBOUNDED they are a memory-pressure
 * knob for anyone who can write the 0600 keyfile: a hand-edited
 * `n: 2**31` sent scryptSync off to a terabyte-scale allocation. These
 * caps leave 8x headroom over the build's own curve (which is ~8x under
 * them); a curve that genuinely needs more ships as a new schema version.
 */
const SCRYPT_N_MAX = 2 ** 18;
const SCRYPT_R_MAX = 16;
const SCRYPT_P_MAX = 8;
const SCRYPT_MAXMEM_MAX = 256 * 1024 * 1024;

/**
 * Why the stored KDF parameters fall outside this build's cost curve, or
 * null when they are within it. Runs BEFORE scrypt sees the parameters,
 * on every stored-params reader (the keyfile envelope and the bundle
 * alike): an absurd cost is refused by name instead of allocated, and a
 * `maxmem` below the parameters' own `128*n*r` need is the named refusal
 * rather than node's raw memory error.
 */
export function kdfCostCurveRefusal(kdf: EnvelopeKdfParams): string | null {
  if (kdf.n > SCRYPT_N_MAX) {
    return `kdf n ${String(kdf.n)} exceeds this build's ceiling ${String(SCRYPT_N_MAX)}`;
  }
  if (kdf.r > SCRYPT_R_MAX) {
    return `kdf r ${String(kdf.r)} exceeds this build's ceiling ${String(SCRYPT_R_MAX)}`;
  }
  if (kdf.p > SCRYPT_P_MAX) {
    return `kdf p ${String(kdf.p)} exceeds this build's ceiling ${String(SCRYPT_P_MAX)}`;
  }
  if (kdf.maxmem > SCRYPT_MAXMEM_MAX) {
    return `kdf maxmem ${String(kdf.maxmem)} exceeds this build's ceiling ${String(SCRYPT_MAXMEM_MAX)}`;
  }
  const needed = 128 * kdf.n * kdf.r;
  if (kdf.maxmem < needed) {
    return (
      `kdf maxmem ${String(kdf.maxmem)} is below the ${String(needed)} bytes ` +
      `these n/r parameters need`
    );
  }
  return null;
}

/** The KDF parameters recorded inside an envelope, so they can migrate. */
export interface EnvelopeKdfParams {
  readonly algo: string;
  /** Base64 random salt, fresh per envelope. */
  readonly salt: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
}

/** The on-disk keyfile envelope: `{ version, kdf, wrapped }`. */
export interface KeyfileEnvelope {
  readonly version: number;
  readonly kdf: EnvelopeKdfParams;
  /** The DEK encrypted under the passphrase-derived key. */
  readonly wrapped: EncryptedValue;
}

/**
 * Closed refusal table for every named failure shape of the envelope.
 * Errors surface by code; nothing is assembled from prose at runtime.
 */
export const ENVELOPE_REFUSAL_CODES = Object.freeze({
  /** The envelope's schema version is not one this build reads. */
  version: "keyfile_envelope_version_refused",
  /** The envelope names a KDF this build does not implement. */
  kdfAlgo: "keyfile_envelope_kdf_algo_refused",
  /** The stored KDF parameters exceed ( or fall below) this build's cost curve. */
  kdfCost: "keyfile_envelope_kdf_params_refused",
  /** The passphrase did not unwrap the DEK (wrong passphrase, or corrupt). */
  passphrase: "keyfile_envelope_passphrase_refused",
  /** The file is envelope-shaped but does not parse as one. */
  malformed: "keyfile_envelope_malformed",
} as const);

export type EnvelopeRefusalCode =
  (typeof ENVELOPE_REFUSAL_CODES)[keyof typeof ENVELOPE_REFUSAL_CODES];

/** A named envelope refusal: the stable `code` is the contract. */
export class SecretEnvelopeError extends Error {
  readonly code: EnvelopeRefusalCode;
  readonly keyPath: string;

  constructor(code: EnvelopeRefusalCode, keyPath: string, detail: string) {
    // Path-free by construction, like the sibling locked-store and
    // missing-keyfile refusals: the prose travels into model context
    // through consumers that surface error text verbatim, and the keyfile
    // path is machine-derived - the operator named --vault, never the
    // keyfile. The path stays on `keyPath` for callers allowed to name
    // the file.
    super(`keyfile envelope refused (${code}): ${detail}`);
    this.name = "SecretEnvelopeError";
    this.code = code;
    this.keyPath = keyPath;
  }
}

/** Stable code every locked-store refusal carries. */
export const SECRET_STORE_LOCKED_CODE = "secret_store_locked";

/**
 * The environment variable a non-interactive host (the MCP server, a
 * cron-driven CLI) sets to hand the store its passphrase: the FIRST
 * key-bearing operation that meets the wrapped keyfile unwraps with it,
 * holds the DEK for the process, and DELETES the variable, so the
 * passphrase never lingers in the environment nor rides into a child
 * process. The value is consumed once per process whether or not it
 * unwraps.
 */
export const SECRET_STORE_PASSPHRASE_ENV = "OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE";

/**
 * A key-bearing operation met a wrapped keyfile and this process holds no
 * unlocked key for it. The remedy is one of: give the passphrase to the
 * key-bearing command itself (`--passphrase-from-env` or stdin - the
 * key-bearing verbs ingest it), set
 * {@link SECRET_STORE_PASSPHRASE_ENV} for a non-interactive host such as
 * the MCP server (read once at the first key operation, then dropped),
 * run the unlock op for this process, or unwrap the store back to a raw
 * keyfile.
 *
 * The MESSAGE is path-free by construction: the prose travels into model
 * context through consumers that surface error text verbatim (a config
 * probe's error list, a search refusal, a CLI catch), and the keyfile
 * path under the vault is exactly what `src/mcp/vault-path-field.ts`
 * degrades to keep out. The structured `keyPath` field stays for the
 * callers that legitimately name the file.
 */
export class SecretStoreLockedError extends Error {
  readonly code = SECRET_STORE_LOCKED_CODE;
  readonly keyPath: string;

  constructor(keyPath: string) {
    super(
      `the secret store is locked (the keyfile is passphrase-wrapped): pass the ` +
        `passphrase to this command via --passphrase-from-env or stdin, or set ` +
        `${SECRET_STORE_PASSPHRASE_ENV} for this process (a non-interactive host such ` +
        `as the MCP server reads it once and drops it), or run ` +
        `"o2b brain secret unlock" to unlock this process only - the passphrase is ` +
        `never persisted; "o2b brain secret unwrap" writes the raw keyfile back`,
    );
    this.name = "SecretStoreLockedError";
    this.keyPath = keyPath;
  }
}

/** Stable code every missing-keyfile refusal carries. */
export const SECRET_STORE_KEYFILE_MISSING_CODE = "secret_store_keyfile_missing";

/**
 * A key-bearing read met a store that still holds entries whose keyfile
 * is gone. The sibling state of the locked refusal, and resolved the same
 * way: minting a fresh key over the surviving ciphertext would orphan
 * every stored value silently, with no error naming the mint, so a read
 * refuses by name and only a restored keyfile recovers the store.
 *
 * The MESSAGE is path-free for the same reason the locked refusal's is:
 * the prose travels into model context through consumers that surface
 * error text verbatim (a config probe's error list, a search refusal, a
 * CLI catch). The structured `keyPath` field stays for the callers that
 * legitimately name the file.
 */
export class SecretStoreKeyfileMissingError extends Error {
  readonly code = SECRET_STORE_KEYFILE_MISSING_CODE;
  readonly keyPath: string;

  constructor(keyPath: string) {
    super(
      `the secret store's keyfile is missing while the store still holds entries: ` +
        `refusing to mint a fresh key over them - restore the keyfile to read the stored secrets`,
    );
    this.name = "SecretStoreKeyfileMissingError";
    this.keyPath = keyPath;
  }
}

// ----- The memory-only unlock holder -----------------------------------------

/**
 * The unlocked DEK per resolved keyfile path, for this process only.
 * Keyed by resolved path so two vaults in one process stay independent,
 * the same keying `owner-acl.ts` uses for its idempotence set.
 */
const HELD_KEYS = new Map<string, Buffer>();

function holderSlot(keyPath: string): string {
  const resolved = resolve(keyPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The key unlocked for `keyPath`, or null. Reads memory only; a locked
 * store and an empty holder are the same answer here.
 */
export function heldUnlockedKey(keyPath: string): Buffer | null {
  return HELD_KEYS.get(holderSlot(keyPath)) ?? null;
}

/**
 * The held key, or the named locked-store refusal. This is the branch
 * `loadOrCreateKey` takes when the keyfile on disk is an envelope.
 *
 * Before refusing, the holder consults the environment once: a host that
 * launched this process with {@link SECRET_STORE_PASSPHRASE_ENV} set
 * (the MCP server, a cron-driven command) unwraps with it at the FIRST
 * key operation - which is the whole of that host's startup story, since
 * the value is consumed and deleted there, whether or not it unwraps. A
 * wrong or absent value leaves the named locked-store refusal standing;
 * a wrong value that was offered is the named passphrase refusal, which
 * says what to fix.
 */
export function heldKeyOrRefusal(keyPath: string): Buffer {
  const held = HELD_KEYS.get(holderSlot(keyPath));
  if (held !== undefined) return held;
  const fromEnvironment = unlockFromEnvironmentOffer(keyPath);
  if (fromEnvironment !== null) return fromEnvironment;
  throw new SecretStoreLockedError(keyPath);
}

/**
 * Consume-once environment unlock. Reads
 * {@link SECRET_STORE_PASSPHRASE_ENV}, DELETES it (so the passphrase
 * neither lingers in the environment of this process nor reaches a child
 * it would later spawn), and unwraps the envelope with the value. Null
 * when the variable is unset - or set empty, which is treated as not
 * offered the same way the CLI's ingestion treats a blank as no
 * passphrase. A non-empty value that does not unwrap is the named
 * passphrase refusal naming the variable; any other envelope refusal
 * (version, cost curve) propagates as itself.
 */
function unlockFromEnvironmentOffer(keyPath: string): Buffer | null {
  const offered = process.env[SECRET_STORE_PASSPHRASE_ENV];
  if (offered === undefined) return null;
  delete process.env[SECRET_STORE_PASSPHRASE_ENV];
  if (offered.length === 0) return null;
  try {
    return unlockKeyfile(keyPath, offered);
  } catch (err) {
    if (err instanceof SecretEnvelopeError && err.code === ENVELOPE_REFUSAL_CODES.passphrase) {
      throw new SecretEnvelopeError(
        ENVELOPE_REFUSAL_CODES.passphrase,
        keyPath,
        `the passphrase in ${SECRET_STORE_PASSPHRASE_ENV} does not unwrap this envelope ` +
          "(wrong passphrase, or the envelope is corrupt)",
      );
    }
    throw err;
  }
}

/** Lock: drop this process's held key, overwriting its bytes first. */
export function clearHeldKey(keyPath: string): void {
  const slot = holderSlot(keyPath);
  const held = HELD_KEYS.get(slot);
  if (held !== undefined) {
    held.fill(0);
    HELD_KEYS.delete(slot);
  }
}

// ----- Envelope shape --------------------------------------------------------

/**
 * Whether `parsed` has the envelope's field shape - WITHOUT judging the
 * version or algo, which `readEnvelope` refuses by name. Detection has to
 * accept an envelope this build cannot read, so a future version surfaces
 * the version refusal rather than the raw-keyfile corrupt-length error.
 */
function hasEnvelopeShape(parsed: unknown): parsed is KeyfileEnvelope {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const candidate = parsed as Partial<KeyfileEnvelope>;
  if (typeof candidate.version !== "number") return false;
  const kdf = candidate.kdf as Partial<EnvelopeKdfParams> | undefined;
  if (typeof kdf !== "object" || kdf === null || typeof kdf.algo !== "string") return false;
  if (typeof kdf.salt !== "string" || typeof kdf.n !== "number") return false;
  if (typeof kdf.r !== "number" || typeof kdf.p !== "number" || typeof kdf.maxmem !== "number") {
    return false;
  }
  const wrapped = candidate.wrapped as Partial<EncryptedValue> | undefined;
  return (
    typeof wrapped === "object" &&
    wrapped !== null &&
    typeof wrapped.ciphertext === "string" &&
    typeof wrapped.iv === "string" &&
    typeof wrapped.tag === "string"
  );
}

/**
 * Whether the bytes at `keyPath` are an envelope. A raw 32-byte keyfile is
 * indistinguishable from garbage to a JSON parser, so a true here is the
 * safe direction; a corrupt ENVELOPE (truncated JSON) reads as false and
 * fails closed on the raw branch's corrupt-length check instead. A missing
 * file is not an envelope - callers check state before acting on it.
 */
export function isEnvelopeFile(keyPath: string): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(keyPath);
  } catch {
    return false;
  }
  return isEnvelopeBytes(bytes);
}

/** {@link isEnvelopeFile} over bytes already read. */
export function isEnvelopeBytes(bytes: Buffer): boolean {
  try {
    return hasEnvelopeShape(JSON.parse(bytes.toString("utf8")));
  } catch {
    return false;
  }
}

/**
 * Strict read: parse, then refuse an unknown version or KDF algo BY NAME.
 * The parameters are validated - shape, and this build's cost curve -
 * before scrypt sees them, so a hand-edited envelope can neither hand the
 * KDF an absurd cost nor starve it below its own memory need.
 */
export function readEnvelope(keyPath: string): KeyfileEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      `not parseable as an envelope: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!hasEnvelopeShape(parsed)) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, "missing fields");
  }
  if (parsed.version !== KEYFILE_ENVELOPE_SCHEMA_VERSION) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.version,
      keyPath,
      `version ${String(parsed.version)} is not read by this build`,
    );
  }
  if (parsed.kdf.algo !== KDF_ALGO) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.kdfAlgo,
      keyPath,
      `kdf algo ${JSON.stringify(parsed.kdf.algo)} is not implemented by this build`,
    );
  }
  if (
    !Number.isInteger(parsed.kdf.n) ||
    parsed.kdf.n <= 0 ||
    !Number.isInteger(parsed.kdf.r) ||
    parsed.kdf.r <= 0 ||
    !Number.isInteger(parsed.kdf.p) ||
    parsed.kdf.p <= 0 ||
    !Number.isInteger(parsed.kdf.maxmem) ||
    parsed.kdf.maxmem <= 0
  ) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      "kdf parameters must be positive integers",
    );
  }
  const costRefusal = kdfCostCurveRefusal(parsed.kdf);
  if (costRefusal !== null) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.kdfCost, keyPath, costRefusal);
  }
  return parsed;
}

// ----- Wrap and unwrap -------------------------------------------------------

/** Fresh KDF parameters: a new random salt under this build's cost curve. */
export function freshWrapKdfParams(): EnvelopeKdfParams {
  return {
    algo: KDF_ALGO,
    salt: randomBytes(SALT_BYTES).toString("base64"),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  };
}

/** Derive the wrap key with the envelope's own stored parameters. */
export function deriveWrapKey(passphrase: string, kdf: EnvelopeKdfParams): Buffer {
  return scryptSync(passphrase, Buffer.from(kdf.salt, "base64"), WRAP_KEY_BYTES, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: kdf.maxmem,
  });
}

function unwrapWith(derived: Buffer, envelope: KeyfileEnvelope, keyPath: string): Buffer {
  let plaintext: string;
  try {
    plaintext = decryptValue(derived, envelope.wrapped);
  } catch {
    // The GCM tag is the passphrase check; a mismatch fails closed here,
    // and the refusal is named rather than a raw cipher error.
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.passphrase,
      keyPath,
      "the passphrase does not unwrap this envelope (wrong passphrase, or the envelope is corrupt)",
    );
  }
  const dek = Buffer.from(plaintext, "base64");
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      `unwrapped key material is ${String(dek.length)} bytes, expected ${String(DEK_BYTES)}`,
    );
  }
  return dek;
}

/**
 * Verify a passphrase against the envelope WITHOUT populating the holder.
 * Used where the caller wants the named refusal and nothing else.
 */
export function verifyKeyfilePassphrase(keyPath: string, passphrase: string): void {
  const envelope = readEnvelope(keyPath);
  unwrapWith(deriveWrapKey(passphrase, envelope.kdf), envelope, keyPath);
}

/** Test seams of {@link wrapKeyfile}, so its failure paths are drivable. */
export interface WrapKeyfileSeams {
  /**
   * Test-only replacement for the seal step, so a test can produce an
   * envelope that does not unwrap to the DEK it claims to wrap (the
   * refusal that must fire BEFORE anything touches the keyfile).
   */
  readonly seal?: (wrapKey: Buffer, plaintextBase64: string) => EncryptedValue;
  /**
   * Test-only replacement for the atomic write, so a test can land bytes
   * that do not parse as the envelope that was built - the read-back
   * verification's restore path.
   */
  readonly write?: (target: string, envelopeText: string) => void;
}

/**
 * Replace the raw keyfile at `keyPath` with the envelope wrapping `dek`
 * under `passphrase`. This swap replaces the ONLY copy of the DEK, so it
 * is armored twice:
 *
 * 1. The in-memory envelope is unwrapped and compared against `dek`
 *    BEFORE any byte touches the filesystem - a seal that does not
 *    round-trip refuses with the raw keyfile untouched.
 * 2. The write goes through the repo's atomic write (temp file, fsync,
 *    rename, parent-dir fsync) at mode 0600, and the file is read back
 *    and unwrapped after the rename; a read-back that fails restores the
 *    raw keyfile bytes (fsync'd, 0600) before refusing, so the wrap can
 *    never leave the key less recoverable than it was.
 *
 * The swapped-in file carries the same owner-only discipline the raw
 * file had: `restrictToOwner` (the Windows ACL) and a 0600 mode on
 * POSIX.
 */
export function wrapKeyfile(
  keyPath: string,
  passphrase: string,
  dek: Buffer,
  seams: WrapKeyfileSeams = {},
): KeyfileEnvelope {
  if (passphrase.length === 0) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.passphrase,
      keyPath,
      "a wrap passphrase must not be empty",
    );
  }
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      `refusing to wrap ${String(dek.length)} bytes of key material, expected ${String(DEK_BYTES)}`,
    );
  }
  const kdf = freshWrapKdfParams();
  const derived = deriveWrapKey(passphrase, kdf);
  const seal = seams.seal ?? ((key: Buffer, plaintext: string) => encryptValue(key, plaintext));
  const envelope: KeyfileEnvelope = {
    version: KEYFILE_ENVELOPE_SCHEMA_VERSION,
    kdf,
    wrapped: seal(derived, dek.toString("base64")),
  };
  // The produced envelope must unwrap to the exact key it wraps, BEFORE
  // the rename replaces the only copy of the raw key with it. A seal
  // that fails this check refuses here and the raw keyfile is untouched.
  const unwrapped = unwrapWith(derived, envelope, keyPath);
  if (!timingSafeEqual(unwrapped, dek)) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      "the produced envelope does not unwrap to the key it wraps; the raw keyfile was left untouched",
    );
  }
  const envelopeText = `${JSON.stringify(envelope, null, 2)}\n`;
  const write =
    seams.write ??
    ((target: string, text: string) => {
      atomicWriteText(target, text, { mode: 0o600 });
    });
  write(keyPath, envelopeText);
  // Read back what actually landed and unwrap it. The rename replaced
  // the raw keyfile, so a mangled or foreign envelope at the path is the
  // destruction of the only copy of the DEK: restore those raw bytes
  // (fsync'd, 0600) before refusing.
  try {
    const landed = readEnvelope(keyPath);
    const restored = unwrapWith(derived, landed, keyPath);
    if (!timingSafeEqual(restored, dek)) {
      throw new SecretEnvelopeError(
        ENVELOPE_REFUSAL_CODES.malformed,
        keyPath,
        "the written envelope does not unwrap to the key it wraps",
      );
    }
  } catch (err) {
    // The rename replaced the raw keyfile, so this restore is the only
    // copy of the DEK left to write - but a restore that fails must not
    // replace the refusal the caller needs: the ORIGINAL error names the
    // read-back fault that actually happened first, so the restore runs
    // inside its own guard and its failure is demoted to a named warning
    // beside the original error, never instead of it.
    try {
      writeRawKeyfileBytes(keyPath, dek);
    } catch (restoreErr) {
      process.stderr.write(
        `warning: could not restore the raw keyfile after a failed read-back check: ` +
          `${keyPath}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
      );
    }
    throw err;
  }
  // The envelope now IS the keyfile: the same owner-only treatment the raw
  // file carried. The rename replaced the file behind this path, so the
  // restriction runs against the idempotence memo - the renamed file
  // inherited the directory's ACL, which must not survive. `restrictToOwner`
  // is the Windows discipline and a no-op elsewhere, where the mode below is
  // the whole story.
  restrictToOwner(keyPath, "file", process.platform, true);
  if (process.platform !== "win32") {
    try {
      chmodSync(keyPath, 0o600);
    } catch (err) {
      process.stderr.write(
        `warning: could not re-apply owner-only mode to the wrapped keyfile: ` +
          `${keyPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return envelope;
}

/**
 * Atomically write the raw DEK bytes over whatever sits at `keyPath`:
 * the restore half of {@link wrapKeyfile}'s read-back check, and the
 * write half of `secret unwrap` (the envelope's way back to a raw
 * keyfile). fsync'd temp file, mode 0600, rename, parent-dir fsync.
 */
export function writeRawKeyfileBytes(keyPath: string, dek: Buffer): void {
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      `refusing to write ${String(dek.length)} bytes of key material, expected ${String(DEK_BYTES)}`,
    );
  }
  const tmp = `${keyPath}.raw-tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    let written = 0;
    while (written < dek.byteLength) {
      written += writeSync(fd, dek, written, dek.byteLength - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, keyPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The first close already ran or the fd is dead; the error below
        // is what the caller needs.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The tmp may never have been created.
    }
    throw err;
  }
  // Best-effort parent-dir fsync, the same durability the repo's atomic
  // write gives every rename: the raw key must survive a crash right
  // after this returns.
  try {
    const dfd = openSync(dirname(keyPath), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Not every platform supports a directory fsync; the rename itself is
    // already atomic.
  }
}

/**
 * Verify the passphrase, then replace the envelope at `keyPath` with the
 * raw DEK bytes it wraps - the way back from a wrapped store to the
 * plain keyfile, and the only recovery when a host cannot carry a
 * passphrase (or the operator wants to retire the wrap). The envelope is
 * only overwritten after the passphrase has unwrapped it, so a wrong
 * passphrase leaves the wrap intact. The raw key material on disk is the
 * caller's warning to give, not this module's.
 */
export function unwrapKeyfileToRaw(keyPath: string, passphrase: string): Buffer {
  const envelope = readEnvelope(keyPath);
  const dek = unwrapWith(deriveWrapKey(passphrase, envelope.kdf), envelope, keyPath);
  writeRawKeyfileBytes(keyPath, dek);
  return dek;
}

/**
 * Unlock: verify the passphrase and hold the DEK for this process.
 * Returns the unwrapped key. A second unlock over an already-held path
 * must unwrap to the SAME key - the comparison is constant-time - or the
 * refusal fires rather than silently replacing held material.
 */
export function unlockKeyfile(keyPath: string, passphrase: string): Buffer {
  const envelope = readEnvelope(keyPath);
  const dek = unwrapWith(deriveWrapKey(passphrase, envelope.kdf), envelope, keyPath);
  const slot = holderSlot(keyPath);
  const held = HELD_KEYS.get(slot);
  if (held !== undefined && !timingSafeEqual(held, dek)) {
    throw new SecretEnvelopeError(
      ENVELOPE_REFUSAL_CODES.malformed,
      keyPath,
      "the passphrase unwrapped a different key than the one this process already holds",
    );
  }
  HELD_KEYS.set(slot, dek);
  return dek;
}
