/**
 * Per-value AES-256-GCM cipher (write-time-integrity-governance).
 *
 * Random 12-byte IV per encryption, authentication tag verified on every
 * decrypt, so a tampered ciphertext fails closed instead of decoding
 * garbage. This module is the LEAF both halves of the keyfile custody
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
