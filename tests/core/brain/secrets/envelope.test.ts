/**
 * Passphrase-wrapped keyfile envelope (t_e6667a56): the raw 32-byte DEK
 * at the keyfile path can be replaced by a versioned scrypt envelope that
 * only a passphrase unwraps, with a process-local, memory-only unlock
 * holder and named refusals for every failure shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearHeldKey,
  ENVELOPE_REFUSAL_CODES,
  heldKeyOrRefusal,
  heldUnlockedKey,
  isEnvelopeFile,
  readEnvelope,
  SecretEnvelopeError,
  SecretStoreLockedError,
  SECRET_STORE_PASSPHRASE_ENV,
  unlockKeyfile,
  unwrapKeyfileToRaw,
  verifyKeyfilePassphrase,
  wrapKeyfile,
} from "../../../../src/core/brain/secrets/envelope.ts";
import { loadOrCreateKey } from "../../../../src/core/brain/secrets/crypto.ts";
import { secretsDir } from "../../../../src/core/brain/secrets/store.ts";
import { encryptValue } from "../../../../src/core/brain/secrets/value-cipher.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

const KEY_BYTES = 32;
const PASSPHRASE = fakeCredential("wrap-pass", "phrase-", "42");
const WRONG_PASSPHRASE = fakeCredential("wrong-pass", "phrase-", "42");

let vault: string;
let keyPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-envelope-"));
  keyPath = join(secretsDir(vault), "keyfile");
  loadOrCreateKey(keyPath);
});

afterEach(() => {
  clearHeldKey(keyPath);
  rmSync(vault, { recursive: true, force: true });
});

/** Every file under the vault, as path + bytes. */
function vaultFiles(): ReadonlyArray<readonly [string, Buffer]> {
  const out: Array<readonly [string, Buffer]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push([abs, readFileSync(abs)]);
    }
  };
  walk(vault);
  return out;
}

describe("the keyfile envelope", () => {
  test("wrap replaces the raw keyfile with the versioned envelope; the raw DEK never appears on disk", () => {
    const dek = loadOrCreateKey(keyPath);
    expect(dek.length).toBe(KEY_BYTES);

    wrapKeyfile(keyPath, PASSPHRASE, dek);

    const raw = readFileSync(keyPath);
    expect(isEnvelopeFile(keyPath)).toBe(true);
    const envelope = readEnvelope(keyPath);
    expect(envelope.version).toBe(1);
    expect(envelope.kdf.algo).toBe("scrypt");
    expect(envelope.kdf.n).toBe(2 ** 15);
    expect(envelope.kdf.r).toBe(8);
    expect(envelope.kdf.p).toBe(1);
    expect(envelope.kdf.maxmem).toBeGreaterThan(128 * 2 ** 15 * 8);
    expect(Buffer.from(envelope.kdf.salt, "base64")).toHaveLength(16);
    expect(envelope.wrapped.ciphertext.length).toBeGreaterThan(0);
    // The envelope is a JSON document now, not 32 raw bytes, and the DEK
    // bytes appear nowhere in it (the wrapped body is ciphertext under a
    // key the passphrase derives).
    expect(raw.length).not.toBe(KEY_BYTES);
    expect(raw.includes(dek)).toBe(false);
    // A fresh load sees the envelope, not the old raw file.
    expect(() => loadOrCreateKey(keyPath)).toThrow(SecretStoreLockedError);
  });

  test("a wrong passphrase fails closed via the GCM tag with the named error", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    clearHeldKey(keyPath);

    expect(() => verifyKeyfilePassphrase(keyPath, WRONG_PASSPHRASE)).toThrow(SecretEnvelopeError);
    try {
      verifyKeyfilePassphrase(keyPath, WRONG_PASSPHRASE);
      throw new Error("expected the passphrase refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretEnvelopeError);
      expect((err as SecretEnvelopeError).code).toBe(ENVELOPE_REFUSAL_CODES.passphrase);
    }
    expect(heldUnlockedKey(keyPath)).toBeNull();
  });

  test("stored scrypt parameters round-trip; an unknown algo or version refuses by name", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    const envelope = readEnvelope(keyPath);
    expect(envelope.kdf.n).toBe(2 ** 15);
    expect(envelope.kdf.r).toBe(8);
    expect(envelope.kdf.p).toBe(1);

    for (const [field, mutate, code] of [
      [
        "version",
        (e: Record<string, unknown>) => void (e["version"] = (e["version"] as number) + 1),
        ENVELOPE_REFUSAL_CODES.version,
      ],
      [
        "algo",
        (e: Record<string, unknown>) =>
          void ((e["kdf"] as Record<string, unknown>)["algo"] = "argon2id"),
        ENVELOPE_REFUSAL_CODES.kdfAlgo,
      ],
    ] as const) {
      const tampered = JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, unknown>;
      mutate(tampered);
      const path = join(secretsDir(vault), `tampered-${field}.json`);
      writeFileSync(path, JSON.stringify(tampered));
      try {
        readEnvelope(path);
        throw new Error(`expected the ${field} refusal`);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretEnvelopeError);
        expect((err as SecretEnvelopeError).code).toBe(code);
      }
    }
  });

  test("unlock populates the process-local holder; lock clears it; a second context sees the refusal", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    clearHeldKey(keyPath);

    expect(heldUnlockedKey(keyPath)).toBeNull();
    const unlocked = unlockKeyfile(keyPath, PASSPHRASE);
    expect(unlocked.equals(dek)).toBe(true);
    expect(heldUnlockedKey(keyPath)!.equals(dek)).toBe(true);
    // The operational loader now serves the held key without touching disk.
    expect(loadOrCreateKey(keyPath).equals(dek)).toBe(true);

    clearHeldKey(keyPath);
    expect(heldUnlockedKey(keyPath)).toBeNull();
    expect(() => heldKeyOrRefusal(keyPath)).toThrow(SecretStoreLockedError);
    // A second context over the same vault (holder empty, envelope on
    // disk) gets the named locked-store refusal, not a minted key.
    expect(() => loadOrCreateKey(keyPath)).toThrow(SecretStoreLockedError);
  });

  test("a hand-edited envelope whose kdf cost exceeds this build's curve refuses by name", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    // n = 2**31 would send scryptSync off to a terabyte-scale allocation
    // before this fix: validation checked positivity only.
    const absurd = JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, unknown>;
    (absurd["kdf"] as Record<string, unknown>)["n"] = 2 ** 31;
    (absurd["kdf"] as Record<string, unknown>)["maxmem"] = 10 ** 12;
    const absurdPath = join(secretsDir(vault), "tampered-absurd-cost.json");
    writeFileSync(absurdPath, JSON.stringify(absurd));
    try {
      verifyKeyfilePassphrase(absurdPath, PASSPHRASE);
      throw new Error("expected the kdf-cost refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretEnvelopeError);
      expect((err as SecretEnvelopeError).code).toBe(ENVELOPE_REFUSAL_CODES.kdfCost);
    }
    // A stored maxmem SMALLER than the parameters' own need used to
    // surface as node's raw "memory limit exceeded" instead of the named
    // refusal.
    const starved = JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, unknown>;
    (starved["kdf"] as Record<string, unknown>)["maxmem"] = 1024;
    const starvedPath = join(secretsDir(vault), "tampered-starved-maxmem.json");
    writeFileSync(starvedPath, JSON.stringify(starved));
    try {
      verifyKeyfilePassphrase(starvedPath, PASSPHRASE);
      throw new Error("expected the kdf-cost refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretEnvelopeError);
      expect((err as SecretEnvelopeError).code).toBe(ENVELOPE_REFUSAL_CODES.kdfCost);
    }
  });

  test("the passphrase is never written anywhere under the vault", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    unlockKeyfile(keyPath, PASSPHRASE);

    for (const [, bytes] of vaultFiles()) {
      expect(bytes.includes(PASSPHRASE)).toBe(false);
    }
  });

  test("a never-wrapped store keeps today's raw keyfile behavior", () => {
    const dek = loadOrCreateKey(keyPath);
    expect(isEnvelopeFile(keyPath)).toBe(false);
    // The second load returns the same bytes; the file stays 32 raw bytes.
    expect(loadOrCreateKey(keyPath).equals(dek)).toBe(true);
    expect(readFileSync(keyPath).length).toBe(KEY_BYTES);
  });

  test("a produced envelope that does not unwrap refuses BEFORE the keyfile is touched", () => {
    // The wrap replaces the only copy of the DEK, so a seal that does not
    // round-trip must refuse while the raw keyfile is still on disk - not
    // discover the breakage after the rename has destroyed it.
    const dek = loadOrCreateKey(keyPath);
    const before = readFileSync(keyPath);
    const brokenTag = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    expect(() =>
      wrapKeyfile(keyPath, PASSPHRASE, dek, {
        seal: (key, plaintext) => ({ ...encryptValue(key, plaintext), tag: brokenTag }),
      }),
    ).toThrow(SecretEnvelopeError);
    // The raw keyfile is exactly as it was.
    expect(readFileSync(keyPath).equals(before)).toBe(true);
    expect(isEnvelopeFile(keyPath)).toBe(false);
    expect(loadOrCreateKey(keyPath).equals(dek)).toBe(true);
  });

  test("a write that lands bytes which are not the envelope restores the raw key and refuses", () => {
    const dek = loadOrCreateKey(keyPath);
    expect(() =>
      wrapKeyfile(keyPath, PASSPHRASE, dek, {
        write: (target) => writeFileSync(target, '{"version": 1, "kdf": {"n": 1'),
      }),
    ).toThrow(SecretEnvelopeError);
    // The read-back check caught the mangled envelope and the raw key
    // bytes were written back before the refusal.
    expect(readFileSync(keyPath).equals(dek)).toBe(true);
    expect(isEnvelopeFile(keyPath)).toBe(false);
    expect(loadOrCreateKey(keyPath).equals(dek)).toBe(true);
    // Windows reports every mode as 666 and enforces none: the owner-only
    // mode is a POSIX property of the restore, pinned only where the
    // platform honours file modes.
    if (process.platform !== "win32") {
      expect((statSync(keyPath).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("a restore that itself fails reports the ORIGINAL read-back refusal, not the restore's", () => {
    const dek = loadOrCreateKey(keyPath);
    // The write lands bytes that are not the envelope (the read-back will
    // refuse), and the restore's own temp path is occupied by a directory,
    // so the restore cannot write the raw bytes back either. The thrown
    // refusal must still be the read-back one - the fault that actually
    // happened first - with the restore's own failure demoted to stderr.
    mkdirSync(`${keyPath}.raw-tmp`);
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let refused: unknown;
    try {
      wrapKeyfile(keyPath, PASSPHRASE, dek, {
        write: (target) => writeFileSync(target, '{"version": 1, "kdf": {"n": 1'),
      });
    } catch (err) {
      refused = err;
    } finally {
      process.stderr.write = original;
    }
    expect(refused).toBeInstanceOf(SecretEnvelopeError);
    expect((refused as Error).message).not.toContain("raw-tmp");
    // The restore failed, so the mangled envelope is what sits at the path.
    expect(readFileSync(keyPath).equals(dek)).toBe(false);
    expect(warnings.join("")).toContain("could not restore the raw keyfile");
  });

  test("a wrapped store unlocks from the environment once and the variable is consumed", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    clearHeldKey(keyPath);
    process.env[SECRET_STORE_PASSPHRASE_ENV] = PASSPHRASE;
    try {
      // The first key operation unlocks - the non-interactive host's
      // startup story, since no prompt is answerable there.
      expect(loadOrCreateKey(keyPath).equals(dek)).toBe(true);
      expect(heldUnlockedKey(keyPath)).not.toBeNull();
      // The value is gone from the environment: consumed, never passed on.
      expect(process.env[SECRET_STORE_PASSPHRASE_ENV]).toBeUndefined();
      // Later key operations serve from the holder.
      expect(loadOrCreateKey(keyPath).equals(dek)).toBe(true);
    } finally {
      delete process.env[SECRET_STORE_PASSPHRASE_ENV];
      clearHeldKey(keyPath);
    }
  });

  test("an environment passphrase that does not unwrap is the named refusal and is still consumed", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    clearHeldKey(keyPath);
    process.env[SECRET_STORE_PASSPHRASE_ENV] = WRONG_PASSPHRASE;
    try {
      // ONE failed attempt: the offer is consumed whether or not it
      // unwraps, so the second attempt sees the locked refusal instead of
      // paying scrypt for the same wrong value again.
      let refusal: unknown;
      try {
        loadOrCreateKey(keyPath);
        throw new Error("expected the passphrase refusal");
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(SecretEnvelopeError);
      expect((refusal as SecretEnvelopeError).code).toBe(ENVELOPE_REFUSAL_CODES.passphrase);
      expect((refusal as Error).message).toContain(SECRET_STORE_PASSPHRASE_ENV);
      expect(process.env[SECRET_STORE_PASSPHRASE_ENV]).toBeUndefined();
      expect(heldUnlockedKey(keyPath)).toBeNull();
      // With the offer consumed, the next attempt is the locked refusal.
      expect(() => loadOrCreateKey(keyPath)).toThrow(SecretStoreLockedError);
    } finally {
      delete process.env[SECRET_STORE_PASSPHRASE_ENV];
      clearHeldKey(keyPath);
    }
  });

  test("unwrapKeyfileToRaw verifies the passphrase, then writes the raw DEK back at 0600", () => {
    const dek = loadOrCreateKey(keyPath);
    wrapKeyfile(keyPath, PASSPHRASE, dek);
    clearHeldKey(keyPath);
    // A wrong passphrase leaves the wrap intact.
    expect(() => unwrapKeyfileToRaw(keyPath, WRONG_PASSPHRASE)).toThrow(SecretEnvelopeError);
    expect(isEnvelopeFile(keyPath)).toBe(true);
    const restored = unwrapKeyfileToRaw(keyPath, PASSPHRASE);
    expect(restored.equals(dek)).toBe(true);
    expect(isEnvelopeFile(keyPath)).toBe(false);
    expect(readFileSync(keyPath).equals(dek)).toBe(true);
    if (process.platform !== "win32") {
      expect((statSync(keyPath).mode & 0o777).toString(8)).toBe("600");
    }
  });
});
