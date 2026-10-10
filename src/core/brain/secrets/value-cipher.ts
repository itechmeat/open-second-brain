/**
 * Per-value AES-256-GCM cipher (write-time-integrity-governance).
 *
 * Random 12-byte IV per encryption, authentication tag verified on every
 * decrypt, so a tampered ciphertext fails closed instead of decoding
 * garbage. An optional associated-data string binds the ciphertext to
 * context that travels OUTSIDE it (the credential bundle binds each
 * value to its entry metadata this way); a decrypt that names different
 * associated data than the encrypt did fails the tag exactly like a
 * wrong key. This module is the LEAF both halves of the keyfile custody
 * share: `crypto.ts` (the keyfile kernel) and `envelope.ts` (the
 * passphrase-wrapped keyfile) each encrypt and decrypt values through it,
 * so neither imports the other - the static back-edge the envelope once
 * took into the kernel closed a two-module cycle whose initialisation
 * order is undefined.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncryptedValue {
  /** Base64 ciphertext. */
  readonly ciphertext: string;
  /** Base64 12-byte IV, unique per encryption. */
  readonly iv: string;
  /** Base64 GCM authentication tag. */
  readonly tag: string;
}

export function encryptValue(key: Buffer, plaintext: string, aad?: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt one value; a wrong key, a tampered payload, or ciphertext that
 * was sealed under different associated data throws. `aad` must be the
 * exact string the encryption side passed - the GCM tag covers it.
 */
export function decryptValue(key: Buffer, encrypted: EncryptedValue, aad?: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
