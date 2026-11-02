/**
 * The attestation signing kernel (delivery trust, card t_3bdb82b0).
 *
 * Ed25519 from `node:crypto` - the tree's first asymmetric crypto, kept
 * to three small pure operations here so the census-visible crypto
 * surface stays auditable: generate, sign, verify. There is no new
 * dependency.
 *
 * The key lifecycle follows the secrets family's posture exactly:
 *
 *   - Keys are OPERATOR-MANAGED. `sign` refuses by name
 *     (`attestation_key_missing`) when no key exists and never mints
 *     one: a key the operator did not create would be a false sense of
 *     attestation, the same reasoning that keeps the custody store from
 *     minting a key over surviving ciphertext.
 *   - The private half is the raw 32-byte Ed25519 seed, born 0600 in a
 *     0700 directory with `restrictToOwner` applied and the secrets
 *     sync-exclusion marker dropped beside it, under
 *     `<vault>/.open-second-brain/keys/attestation/`. Not inside
 *     `secrets/` itself - the custody store has its own lock/unlock
 *     semantics and a signing key must not gate on the store's locked
 *     state - and never under `Brain/`, which syncs across peers. Git
 *     exclusion is seeded here; file-syncer exclusion is the operator's
 *     `.stignore`, which the doctor names.
 *   - The passphrase wrap reuses the envelope module's `wrapKeyfile` /
 *     `unlockKeyfile` unchanged, so the wrapped form is byte-compatible
 *     with the custody keyfile's envelope and every refusal code it
 *     already names. The passphrase is ingested as an ENV VAR NAME
 *     (`passphraseFromEnv`), never a value in argv, and the value may be
 *     a `$secret:` reference resolved through the named-secret resolver.
 *   - Key loss means no recovery, stated like `envelope.ts` and
 *     `bundle.ts` state it: a lost key leaves every past attestation
 *     unverifiable, and rotation is keygen plus re-sign, never
 *     re-signing of old records.
 *   - Key material is never printed. Nothing here writes stdout at all;
 *     error prose is path-free where it travels into model context.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  FileAlreadyExistsError,
} from "../../fs-atomic.ts";
import {
  isEnvelopeBytes,
  unlockKeyfile,
  wrapKeyfile,
  heldKeyOrRefusal,
} from "../../brain/secrets/envelope.ts";
import { restrictToOwner } from "../secrets/owner-acl.ts";
import { resolveNamedSecret } from "../../secret-resolver.ts";
import { WRITE_LANE } from "../freeze-marker.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  attestationSealVerifies,
  attestationSigningPayload,
  type AttestationRecord,
} from "./record.ts";

/** The stable code every missing-key refusal carries. */
export const ATTESTATION_KEY_MISSING = "attestation_key_missing";

/**
 * A signing operation met a vault with no generated attestation key.
 * The remedy is `o2b brain attest keygen` - and the refusal NEVER
 * generates one, because a key an operator did not create would attest
 * nothing they can vouch for.
 */
export class AttestationKeyMissingError extends Error {
  readonly code = ATTESTATION_KEY_MISSING;

  constructor() {
    super(
      "no attestation key exists: generate one with `o2b brain attest keygen` - " +
        "signing never creates a key, because a key the operator did not generate " +
        "would be a false sense of attestation",
    );
    this.name = "AttestationKeyMissingError";
  }
}

/** Refusal for keygen over an existing key: regenerating would orphan past attestations. */
export class AttestationKeyExistsError extends Error {
  readonly code = "attestation_key_exists";

  constructor(privatePath: string) {
    super(
      "an attestation key already exists: refusing to regenerate - every attestation " +
        "signed with the existing key would become unverifiable. Rotation is a " +
        "deliberate act: move the old key aside, then generate",
    );
    this.name = "AttestationKeyExistsError";
    void privatePath;
  }
}

/** Refusal when the passphrase source names no usable value. */
export class AttestationPassphraseError extends Error {
  readonly code = "attestation_passphrase_missing";

  constructor(source: string) {
    super(
      `passphrase source ${JSON.stringify(source)} is unset, empty, or blank; ` +
        "set the environment variable to the passphrase (or to a $secret: reference), " +
        "or pipe it via stdin on the CLI - the passphrase is never taken from argv",
    );
    this.name = "AttestationPassphraseError";
  }
}

const KEY_DIR_SEGMENTS = ["keys", "attestation"] as const;
const PRIVATE_KEY_FILE = "attestation.key";
const PUBLIC_KEY_FILE = "attestation.pub";

/**
 * The fixed PKCS#8 DER prefix of an Ed25519 private key: the ASN.1
 * wrapper around the 32-byte seed. The seed stored on disk plus this
 * prefix is a valid PKCS#8 `PrivateKeyInfo`, which `createPrivateKey`
 * reads directly.
 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const SYNC_EXCLUSION_CONTENT = "*\n!.gitignore\n";

/** `<vault>/.open-second-brain/keys/attestation/`. */
export function attestationKeysDir(vault: string): string {
  return join(vault, ".open-second-brain", ...KEY_DIR_SEGMENTS);
}

/** Both halves of the operator's attestation key, without reading either. */
export function attestationKeyPaths(vault: string): {
  readonly privatePath: string;
  readonly publicPath: string;
} {
  const dir = attestationKeysDir(vault);
  return { privatePath: join(dir, PRIVATE_KEY_FILE), publicPath: join(dir, PUBLIC_KEY_FILE) };
}

/**
 * Best-effort owner-only hardening, applied on creation AND on every
 * load (a keyfile that arrived with a copied or restored vault carries
 * whatever ACL it inherited). Idempotent per path per process, like the
 * custody store's use.
 */
function hardenKeyPaths(dir: string, privatePath: string): void {
  restrictToOwner(dir, "directory");
  restrictToOwner(privatePath, "file");
  // POSIX mirror: mode bits are set at creation only, so a keyfile that
  // arrived with a copy keeps whatever mode the copy gave it. The
  // custody store re-chmods on load; this module cannot - a re-chmod is
  // a direct write-site the census would have to carry an exclusion for,
  // and silently rewriting permissions the operator's restore set is not
  // obviously the right act anyway - so a loose mode is NAMED on stderr
  // and left for the operator to fix deliberately.
  if (process.platform !== "win32" && existsSync(privatePath)) {
    const mode = statSync(privatePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      process.stderr.write(
        `warning: the attestation private key is readable beyond its owner ` +
          `(${mode.toString(8)}); tighten it with chmod 600 ${privatePath}\n`,
      );
    }
  }
}

/** Resolve the passphrase from an env-var NAME; `$secret:` references included. */
function ingestPassphrase(vault: string, passphraseFromEnv: string): string {
  const offered = process.env[passphraseFromEnv];
  if (offered === undefined || offered.trim().length === 0) {
    throw new AttestationPassphraseError(passphraseFromEnv);
  }
  return resolveNamedSecret(vault, offered);
}

/** Seed bytes -> signing KeyObject, via the fixed PKCS#8 wrapper. */
function seedToPrivateKey(seed: Buffer): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export interface GenerateAttestationKeypairOptions {
  /**
   * NAME of the environment variable holding the wrap passphrase (never
   * the passphrase itself, and never argv). When set, the private
   * keyfile is stored as a passphrase-wrapped envelope at the same
   * path; the value may be a `$secret:` reference.
   */
  readonly passphraseFromEnv?: string;
}

/**
 * Generate the operator's Ed25519 attestation keypair.
 *
 * The seed is written through the exclusive-create shared writer at
 * 0600 so two concurrent keygens cannot truncate each other: the loser
 * refuses with {@link AttestationKeyExistsError} rather than replacing
 * the winner. A keypair that survives in ANY half refuses too - a
 * surviving public half still verifies every past attestation, and
 * regenerating over it would orphan them - and the exclusive-create
 * race loser's own error is translated onto the same named refusal. The
 * public half is written beside the private one (safe to copy to every
 * peer), and the sync-exclusion marker keeps git from ever carrying the
 * directory.
 */
export function generateAttestationKeypair(
  vault: string,
  opts: GenerateAttestationKeypairOptions = {},
): { readonly privatePath: string; readonly publicPath: string } {
  // The passphrase is resolved BEFORE anything is created: a refused
  // wrap leaves no half-built key directory behind.
  const passphrase =
    opts.passphraseFromEnv === undefined ? null : ingestPassphrase(vault, opts.passphraseFromEnv);
  assertVaultIdentityForWrite(vault, undefined, WRITE_LANE.audit);
  const { privatePath, publicPath } = attestationKeyPaths(vault);
  if (existsSync(privatePath) || existsSync(publicPath)) {
    // Name the half that actually survives: a refusal pointing at a file
    // that does not exist sends the operator looking in the wrong place.
    throw new AttestationKeyExistsError(existsSync(privatePath) ? privatePath : publicPath);
  }
  const dir = attestationKeysDir(vault);
  // The 0700 mode takes effect on POSIX for directories this call
  // creates; `restrictToOwner` sets the equivalent ACL on Windows.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwner(dir, "directory");
  atomicWriteFileSync(join(dir, ".gitignore"), SYNC_EXCLUSION_CONTENT);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const seed = pkcs8.subarray(ED25519_PKCS8_PREFIX.length);
  // Exclusive create at 0600: the seed never exists at a wider mode,
  // even for an instant. It is stored as hex TEXT - the shared writers
  // encode UTF-8, and 64 hex characters survive any text round trip
  // byte-identically, which raw binary through a text writer does not.
  // A concurrent keygen that passes the pre-check above loses here, and
  // its refusal carries the same named code the pre-check gives.
  try {
    atomicCreateFileSyncExclusive(privatePath, seed.toString("hex"), { mode: 0o600 });
  } catch (err) {
    if (err instanceof FileAlreadyExistsError) throw new AttestationKeyExistsError(privatePath);
    throw err;
  }
  restrictToOwner(privatePath, "file");
  const written = Buffer.from(readFileSync(privatePath, "utf8").trim(), "hex");
  if (!seed.equals(written)) {
    throw new Error("attestation keygen: the private seed did not survive its write");
  }
  atomicWriteFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }) + "\n");

  if (passphrase !== null) {
    // Replaces the raw seed with the envelope at the SAME path, 0600,
    // round-trip verified by the envelope module before any byte lands.
    wrapKeyfile(privatePath, passphrase, seed);
  }
  return { privatePath, publicPath };
}

export interface SignAttestationRecordOptions {
  /** NAME of the environment variable holding the wrap passphrase. */
  readonly passphraseFromEnv?: string;
}

/**
 * Sign one sealed record with the vault's attestation key.
 *
 * Refuses by name with {@link ATTESTATION_KEY_MISSING} when no key
 * exists - never generates. The signature covers
 * `attestationSigningPayload(record)`: the sealed body's canonical JSON
 * without the signature field, so the signed bytes are derivable from
 * the record alone on every build.
 */
export function signAttestationRecord(
  record: AttestationRecord,
  vault: string,
  opts: SignAttestationRecordOptions = {},
): AttestationRecord {
  const { privatePath } = attestationKeyPaths(vault);
  if (!existsSync(privatePath)) throw new AttestationKeyMissingError();
  const dir = attestationKeysDir(vault);
  hardenKeyPaths(dir, privatePath);

  const seed = loadPrivateKeySeed(vault, privatePath, opts.passphraseFromEnv);
  const privateKey = seedToPrivateKey(seed);

  // A record whose seal no longer holds is not signed - signing tampered
  // evidence would launder it.
  if (!attestationSealVerifies(record)) {
    throw new Error(`refusing to sign attestation ${record.id}: its seal does not verify`);
  }

  const signature = cryptoSign(
    null,
    Buffer.from(attestationSigningPayload(record), "utf8"),
    privateKey,
  );
  return Object.freeze({ ...record, signature: signature.toString("base64") });
}

/**
 * The stored seed: raw 32 bytes, or the envelope's held/unwrapped DEK.
 * A passphrase source unlocks the envelope for this process on the way
 * (the envelope holder keeps it, exactly like the custody store).
 */
function loadPrivateKeySeed(
  vault: string,
  privatePath: string,
  passphraseFromEnv: string | undefined,
): Buffer {
  const raw = readFileSync(privatePath, "utf8");
  if (!isEnvelopeBytes(Buffer.from(raw, "utf8"))) {
    const seed = Buffer.from(raw.trim(), "hex");
    if (raw.trim().length !== 64 || seed.length !== 32) {
      throw new Error(
        `attestation keyfile is corrupt (expected a 32-byte seed as hex): ${privatePath}`,
      );
    }
    return seed;
  }
  if (passphraseFromEnv !== undefined) {
    return unlockKeyfile(privatePath, ingestPassphrase(vault, passphraseFromEnv));
  }
  // No source offered: the process holder, then the host's passphrase
  // env bridge, then the named locked refusal.
  return heldKeyOrRefusal(privatePath);
}

export interface VerifyAttestationSignatureOptions {
  /** The public half to verify against; defaults to the vault's own. */
  readonly publicPath?: string;
}

/**
 * Whether `record` carries a valid signature made by the operator's key.
 *
 * False - never a throw - for every negative: no signature, a seal that
 * no longer verifies, a missing or unreadable public half, a forged
 * signature. Verification is a report, and a boolean report cannot
 * refuse a caller that only asked.
 */
export function verifyAttestationSignature(
  record: AttestationRecord,
  vault: string,
  opts: VerifyAttestationSignatureOptions = {},
): boolean {
  if (record.signature === null) return false;
  // The seal first: a body that does not match its own digest is not
  // the body anyone signed, whatever the signature decodes against.
  if (!attestationSealVerifies(record)) return false;

  // An EXPLICIT public path is a contract: verify against exactly that
  // half, and a missing or unreadable file is false - a caller naming a
  // peer's key never means "fall back to whatever is here".
  let publicKey: ReturnType<typeof createPublicKey> | null = null;
  if (opts.publicPath !== undefined) {
    try {
      publicKey = createPublicKey(readFileSync(opts.publicPath, "utf8"));
    } catch {
      return false;
    }
  } else {
    // The default path: the vault's exported public half. Gone (or
    // unreadable) but the private seed still here, local verification
    // derives the public half rather than reporting every local record
    // invalid over a missing export file - peers verify against the
    // exported copy.
    const { publicPath, privatePath } = attestationKeyPaths(vault);
    try {
      publicKey = createPublicKey(readFileSync(publicPath, "utf8"));
    } catch {
      if (!existsSync(privatePath)) return false;
      try {
        const seed = loadPrivateKeySeed(vault, privatePath, undefined);
        publicKey = createPublicKey(seedToPrivateKey(seed));
      } catch {
        return false;
      }
    }
  }
  if (publicKey === null) return false;

  try {
    return cryptoVerify(
      null,
      Buffer.from(attestationSigningPayload(record), "utf8"),
      publicKey,
      Buffer.from(record.signature, "base64"),
    );
  } catch {
    return false;
  }
}
