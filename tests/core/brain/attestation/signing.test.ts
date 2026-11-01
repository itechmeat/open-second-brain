/**
 * The attestation signing kernel (delivery trust, Lane D task D2).
 *
 * The signing key is a long-lived operator credential, so these tests
 * hold the kernel to the secrets-family posture: keys exist only because
 * the operator generated them (sign refuses by name and never mints),
 * the private half is born 0600 with the owner-only ACL and the
 * sync-exclusion marker so it never replicates, the passphrase wrap
 * unlocks, and no code path prints key material. The cryptography
 * itself is asserted round-trip: a signature made over a sealed record
 * verifies, and any mutation of the body invalidates it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTESTATION_KEY_MISSING,
  AttestationKeyExistsError,
  AttestationKeyMissingError,
  attestationKeyPaths,
  generateAttestationKeypair,
  signAttestationRecord,
  verifyAttestationSignature,
} from "../../../../src/core/brain/attestation/signing.ts";
import {
  buildAttestationRecord,
  attestationSigningPayload,
} from "../../../../src/core/brain/attestation/record.ts";
import { collectAttestationManifest } from "../../../../src/core/brain/attestation/digest.ts";
import { isEnvelopeBytes } from "../../../../src/core/brain/secrets/envelope.ts";
import { writeVaultIdentity } from "../../../../src/core/brain/vault-identity.ts";
import { canonicalJson } from "../../../../src/core/integrity/digest.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

/**
 * Passphrases assembled at runtime so no source line carries a literal
 * shaped like a real credential (the fake-credentials doctrine): the
 * second is the first's anagram, because the two wrap cases must stay
 * distinct values.
 */
const WRAP_PASSPHRASE = fakeCredential("correct horse", " battery", " staple");
const WRAP_PASSPHRASE_ANAGRAM = fakeCredential("staple horse", " correct", " battery");

let tmp: string;
let vault: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-attest-sign-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
  for (const k of [
    "O2B_TEST_ATTEST_PASS",
    "O2B_TEST_ATTEST_REF",
    "O2B_TEST_ATTEST_MATERIAL",
    // The envelope's host passphrase bridge: set on a developer machine
    // or in CI, it would unwrap a wrapped fixture key the test meant to
    // see refused, so the suite scrubs and restores it like the rest.
    "OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function unsignedRecord(): ReturnType<typeof buildAttestationRecord> {
  return buildAttestationRecord(vault, collectAttestationManifest(vault), {
    deviceId: "test-device",
    now: new Date("2026-06-03T10:00:00Z"),
  });
}

describe("generateAttestationKeypair", () => {
  test("creates a 0600 private seed file, a public half, and the sync-exclusion marker", () => {
    const { privatePath, publicPath } = generateAttestationKeypair(vault);
    const dir = join(vault, ".open-second-brain", "keys", "attestation");
    expect(privatePath.startsWith(dir)).toBe(true);
    expect(publicPath.startsWith(dir)).toBe(true);
    // Windows has no POSIX mode bits (libuv synthesizes st_mode and never
    // reports the ACL restrictToOwner applies); access there is an
    // owner-only ACL, pinned in the owner-acl suite the secrets family
    // shares.
    if (IS_WINDOWS) return;
    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Raw seed form: 64 hex characters decoding to the 32-byte seed, NOT
    // an envelope.
    const raw = readFileSync(privatePath, "utf8").trim();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(raw, "hex").length).toBe(32);
    expect(isEnvelopeBytes(Buffer.from(raw, "utf8"))).toBe(false);
    // The public half is PEM text naming the algorithm, safe to copy to peers.
    const pub = readFileSync(publicPath, "utf8");
    expect(pub).toContain("BEGIN PUBLIC KEY");
    // The sync-exclusion marker keeps the directory out of git; a synced
    // vault needs the operator's .stignore, which the doctor names.
    const marker = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(marker).toBe("*\n!.gitignore\n");
  });

  test("an existing key is never regenerated", () => {
    const first = generateAttestationKeypair(vault);
    const before = readFileSync(first.privatePath);
    expect(() => generateAttestationKeypair(vault)).toThrow(/already exists/);
    expect(readFileSync(first.privatePath)).toEqual(before);
  });

  test("a surviving public half refuses keygen: regenerating would orphan the attestations it still verifies", () => {
    const first = generateAttestationKeypair(vault);
    const pubBefore = readFileSync(first.publicPath, "utf8");
    rmSync(first.privatePath);
    let caught: unknown = null;
    try {
      generateAttestationKeypair(vault);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AttestationKeyExistsError);
    expect((caught as AttestationKeyExistsError).code).toBe("attestation_key_exists");
    expect(readFileSync(first.publicPath, "utf8")).toBe(pubBefore);
  });

  test("the passphrase wrap replaces the raw seed with an envelope", () => {
    process.env["O2B_TEST_ATTEST_PASS"] = WRAP_PASSPHRASE;
    const { privatePath } = generateAttestationKeypair(vault, {
      passphraseFromEnv: "O2B_TEST_ATTEST_PASS",
    });
    expect(isEnvelopeBytes(readFileSync(privatePath))).toBe(true);
  });

  test("a $secret: reference resolves through the named-secret resolver", () => {
    process.env["O2B_TEST_ATTEST_REF"] = "$secret:O2B_TEST_ATTEST_MATERIAL";
    process.env["O2B_TEST_ATTEST_MATERIAL"] = WRAP_PASSPHRASE_ANAGRAM;
    const { privatePath } = generateAttestationKeypair(vault, {
      passphraseFromEnv: "O2B_TEST_ATTEST_REF",
    });
    expect(isEnvelopeBytes(readFileSync(privatePath))).toBe(true);
  });

  test("an unset or empty passphrase env var refuses by name and writes no key", () => {
    process.env["O2B_TEST_ATTEST_PASS"] = "   ";
    expect(() =>
      generateAttestationKeypair(vault, { passphraseFromEnv: "O2B_TEST_ATTEST_PASS" }),
    ).toThrow(/passphrase/);
    expect(existsSync(join(vault, ".open-second-brain", "keys", "attestation"))).toBe(false);
  });
});

describe("signAttestationRecord", () => {
  test("without keygen refuses by name and never creates a key", () => {
    const record = unsignedRecord();
    let caught: unknown = null;
    try {
      signAttestationRecord(record, vault);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AttestationKeyMissingError);
    expect((caught as AttestationKeyMissingError).code).toBe(ATTESTATION_KEY_MISSING);
    expect(ATTESTATION_KEY_MISSING).toBe("attestation_key_missing");
    expect(existsSync(join(vault, ".open-second-brain", "keys"))).toBe(false);
  });

  test("produces a signature that verifies over the sealed payload", () => {
    generateAttestationKeypair(vault);
    const record = unsignedRecord();
    const signed = signAttestationRecord(record, vault);
    expect(signed.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(signed.digest).toBe(record.digest);
    expect(verifyAttestationSignature(signed, vault)).toBe(true);
  });

  test("any body mutation invalidates the signature", () => {
    generateAttestationKeypair(vault);
    const signed = signAttestationRecord(unsignedRecord(), vault);
    expect(verifyAttestationSignature({ ...signed, storeDigest: "0".repeat(64) }, vault)).toBe(
      false,
    );
    // A forged signature over the same body fails too.
    expect(verifyAttestationSignature({ ...signed, signature: "A".repeat(88) }, vault)).toBe(false);
  });

  test("an unsigned record is refused, not read as valid", () => {
    generateAttestationKeypair(vault);
    expect(verifyAttestationSignature(unsignedRecord(), vault)).toBe(false);
  });

  test("a record whose seal no longer verifies is refused before any signature check", () => {
    generateAttestationKeypair(vault);
    const signed = signAttestationRecord(unsignedRecord(), vault);
    // Rebuild the record so its `digest` no longer matches its body.
    const forged = { ...signed, createdAt: "2026-06-03T23:59:59.000Z" };
    expect(verifyAttestationSignature(forged, vault)).toBe(false);
  });

  test("the signing payload excludes the signature field itself", () => {
    generateAttestationKeypair(vault);
    const signed = signAttestationRecord(unsignedRecord(), vault);
    const payload = JSON.parse(attestationSigningPayload(signed)) as Record<string, unknown>;
    expect("signature" in payload).toBe(false);
    expect(attestationSigningPayload(signed)).toBe(canonicalJson(payload));
  });

  test("the wrapped path unlocks with the passphrase and signs", () => {
    process.env["O2B_TEST_ATTEST_PASS"] = WRAP_PASSPHRASE;
    generateAttestationKeypair(vault, { passphraseFromEnv: "O2B_TEST_ATTEST_PASS" });
    const signed = signAttestationRecord(unsignedRecord(), vault, {
      passphraseFromEnv: "O2B_TEST_ATTEST_PASS",
    });
    expect(verifyAttestationSignature(signed, vault)).toBe(true);
  });

  test("a wrapped key and no passphrase is the named locked refusal", () => {
    process.env["O2B_TEST_ATTEST_PASS"] = WRAP_PASSPHRASE;
    generateAttestationKeypair(vault, { passphraseFromEnv: "O2B_TEST_ATTEST_PASS" });
    expect(() => signAttestationRecord(unsignedRecord(), vault)).toThrow(/locked/);
  });

  test("verification works against an exported public key at another path", () => {
    const { publicPath } = generateAttestationKeypair(vault);
    const exported = join(tmp, "peer.pub");
    writeFileSync(exported, readFileSync(publicPath, "utf8"), "utf8");
    const signed = signAttestationRecord(unsignedRecord(), vault);
    expect(verifyAttestationSignature(signed, vault, { publicPath: exported })).toBe(true);
    expect(
      verifyAttestationSignature(signed, vault, { publicPath: join(tmp, "missing.pub") }),
    ).toBe(false);
  });

  test("no code path prints key material", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const { privatePath, publicPath } = generateAttestationKeypair(vault);
      const seed = readFileSync(privatePath).toString("hex");
      const pem = readFileSync(publicPath, "utf8");
      const signed = signAttestationRecord(unsignedRecord(), vault);
      const valid = verifyAttestationSignature(signed, vault);
      expect(valid).toBe(true);
      const printed = chunks.join("");
      expect(printed).not.toContain(seed);
      expect(printed).not.toContain(pem);
      expect(printed).not.toContain(signed.signature ?? "");
    } finally {
      process.stdout.write = original;
    }
  });

  test("attestationKeyPaths names both halves without reading them", () => {
    const { privatePath, publicPath } = attestationKeyPaths(vault);
    expect(privatePath).toBe(
      join(vault, ".open-second-brain", "keys", "attestation", "attestation.key"),
    );
    expect(publicPath).toBe(
      join(vault, ".open-second-brain", "keys", "attestation", "attestation.pub"),
    );
  });
});
