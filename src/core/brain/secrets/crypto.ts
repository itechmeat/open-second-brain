/**
 * Secret-custody crypto kernel (write-time-integrity-governance).
 *
 * Per-value AES-256-GCM from node:crypto - random 12-byte IV per
 * encryption, authentication tag verified on every decrypt, so a
 * tampered ciphertext fails closed instead of decoding garbage. The
 * 32-byte key lives in a 0600 keyfile beside the ciphertext store (an
 * owner-only ACL on Windows, see `owner-acl.ts`); both stay under the
 * vault-local state dir, which is excluded from git by a marker file and
 * must be excluded from a file syncer by the operator (see
 * `SYNC_EXCLUSION_CONTENT` below).
 *
 * Honest threat model (documented, not implied): this protects
 * against secret values entering an agent's context, against vault
 * sync/export leakage, and against casual reads of vault markdown.
 * It does NOT protect against root or same-user processes on the
 * host - there is no daemon and no TPM in this design.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { restrictToOwner } from "./owner-acl.ts";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The git-exclusion marker this directory carries: a vault that is a git
 * repository does not ignore dot-directories by default, so without it
 * the keyfile and the ciphertext would ride the next commit. `*` excludes
 * everything; `!.gitignore` keeps the marker itself under version control
 * so the exclusion survives a clone.
 *
 * It covers GIT ONLY. Syncthing never reads a `.gitignore`: its one
 * exclusion list is the `.stignore` at the synced folder's root, which is
 * the operator's file and is not edited here. `./sync-exposure.ts`
 * detects a vault inside a Syncthing folder whose `.stignore` does not
 * cover this directory, and the doctor and `secret set` name the line to
 * add. Other file syncers have their own rules and are not covered.
 */
const SYNC_EXCLUSION_CONTENT = "*\n!.gitignore\n";

/**
 * Drop the exclusion marker into `dir`, once, best-effort. Nothing in
 * src ever writes a `.gitignore` elsewhere (every other reference in the
 * tree is a reader), so this file IS the guarantee that the keyfile and
 * the ciphertext do not ride a git commit to another machine.
 */
function ensureSyncExclusionMarker(dir: string): void {
  const marker = join(dir, ".gitignore");
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, SYNC_EXCLUSION_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      process.stderr.write(
        `warning: could not write the sync-exclusion marker for the secrets directory: ` +
          `${marker}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export interface EncryptedValue {
  /** Base64 ciphertext. */
  readonly ciphertext: string;
  /** Base64 12-byte IV, unique per encryption. */
  readonly iv: string;
  /** Base64 GCM authentication tag. */
  readonly tag: string;
}

/** Load the keyfile, creating it 0600 with 32 random bytes on first use. */
export function loadOrCreateKey(keyPath: string): Buffer {
  const keyDir = dirname(keyPath);
  if (existsSync(keyPath)) {
    // On Windows the owner-only ACL is (re)applied on load too, not only
    // at creation: a secrets directory that came in with a copied or
    // restored vault carries whatever ACL it inherited at its new place.
    // `restrictToOwner` is idempotent and runs once per path per process.
    restrictToOwner(keyDir, "directory");
    restrictToOwner(keyPath, "file");
    // The POSIX mirror of that re-application: mode bits are set only at
    // creation, so a keyfile that arrived with a copy or a tar restore
    // keeps whatever mode the copy gave it - 0644 included - forever,
    // because `restrictToOwner` is a no-op here. Warn-and-continue, like
    // the Windows path: the key is already on disk, and refusing to read
    // it would break every secret operation over a repairable bit.
    if (process.platform !== "win32") {
      try {
        chmodSync(keyDir, 0o700);
        chmodSync(keyPath, 0o600);
      } catch (err) {
        process.stderr.write(
          `warning: could not re-apply owner-only modes to the secrets keyfile: ` +
            `${keyPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    ensureSyncExclusionMarker(keyDir);
    const key = readFileSync(keyPath);
    if (key.length !== KEY_BYTES) {
      throw new Error(`secrets keyfile is corrupt (expected ${KEY_BYTES} bytes): ${keyPath}`);
    }
    return key;
  }
  // The `0700` mode takes effect on POSIX only for a directory this call
  // creates. Windows ignores the mode; `restrictToOwner` sets the
  // equivalent ACL there, whoever created the directory.
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  restrictToOwner(keyDir, "directory");
  ensureSyncExclusionMarker(keyDir);
  const key = randomBytes(KEY_BYTES);
  // Exclusive create: two concurrent first-writers cannot truncate
  // each other's key; the loser re-reads the winner's file.
  let fd: number;
  try {
    fd = openSync(keyPath, "wx", 0o600);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey(keyPath);
    throw exc;
  }
  try {
    writeSync(fd, key);
  } finally {
    closeSync(fd);
  }
  restrictToOwner(keyPath, "file");
  return key;
}

export function encryptValue(key: Buffer, plaintext: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt one value; a wrong key or tampered payload throws. */
export function decryptValue(key: Buffer, encrypted: EncryptedValue): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
