/**
 * Secret-custody crypto kernel (write-time-integrity-governance).
 *
 * Per-value AES-256-GCM from node:crypto - random 12-byte IV per
 * encryption, authentication tag verified on every decrypt, so a
 * tampered ciphertext fails closed instead of decoding garbage. The
 * 32-byte key lives in a 0600 keyfile beside the ciphertext store;
 * both stay under the vault-local state dir that never syncs as
 * vault content.
 *
 * Honest threat model (documented, not implied): this protects
 * against secret values entering an agent's context, against vault
 * sync/export leakage, and against casual reads of vault markdown.
 * It does NOT protect against root or same-user processes on the
 * host - there is no daemon and no TPM in this design.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

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
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath);
    if (key.length !== KEY_BYTES) {
      throw new Error(`secrets keyfile is corrupt (expected ${KEY_BYTES} bytes): ${keyPath}`);
    }
    return key;
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
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
