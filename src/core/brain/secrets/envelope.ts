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
 * passphrase itself is never persisted, logged, or audited.
 *
 * Honest warning, stated here because there is no recovery path and none
 * is pretended: a lost passphrase makes every stored secret permanently
 * unreadable. Against a root or same-user attacker nothing here helps -
 * the threat model in `crypto.ts` is unchanged.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renameWithRetry } from "../../fs-atomic.ts";
import { type EncryptedValue, decryptValue, encryptValue } from "./crypto.ts";
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
    super(`keyfile envelope refused (${code}): ${detail}: ${keyPath}`);
    this.name = "SecretEnvelopeError";
    this.code = code;
    this.keyPath = keyPath;
  }
}

/** Stable code every locked-store refusal carries. */
export const SECRET_STORE_LOCKED_CODE = "secret_store_locked";

/**
 * A key-bearing operation met a wrapped keyfile and this process holds no
 * unlocked key for it. The remedy is the unlock op, named in the message.
 */
export class SecretStoreLockedError extends Error {
  readonly code = SECRET_STORE_LOCKED_CODE;
  readonly keyPath: string;

  constructor(keyPath: string) {
    super(
      `the secret store is locked (the keyfile is passphrase-wrapped): run ` +
        `"o2b brain secret unlock" to unwrap it for this process: ${keyPath}`,
    );
    this.name = "SecretStoreLockedError";
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
 */
export function heldKeyOrRefusal(keyPath: string): Buffer {
  const held = HELD_KEYS.get(holderSlot(keyPath));
  if (held === undefined) throw new SecretStoreLockedError(keyPath);
  return held;
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
 * The parameters are validated before scrypt sees them, so a hand-edited
 * envelope cannot hand the KDF an absurd cost.
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

/**
 * Replace the raw keyfile at `keyPath` with the envelope wrapping `dek`
 * under `passphrase`. The swap is atomic and lands at mode 0600: a torn
 * wrap would destroy the only copy of the DEK, and the file this replaces
 * was owner-only, so the envelope must inherit exactly that discipline.
 */
export function wrapKeyfile(keyPath: string, passphrase: string, dek: Buffer): KeyfileEnvelope {
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
  const envelope: KeyfileEnvelope = {
    version: KEYFILE_ENVELOPE_SCHEMA_VERSION,
    kdf,
    wrapped: encryptValue(deriveWrapKey(passphrase, kdf), dek.toString("base64")),
  };
  const tmp = `${keyPath}.wrap-tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameWithRetry(tmp, keyPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The tmp may never have been created; the original error is what
      // the caller needs.
    }
    throw err;
  }
  // The envelope now IS the keyfile: the same owner-only treatment the raw
  // file carried. `restrictToOwner` is the Windows discipline and a no-op
  // elsewhere, where the mode below is the whole story.
  restrictToOwner(keyPath, "file");
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
