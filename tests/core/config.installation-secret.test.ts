/**
 * Device-local installation secret (D2 hardening, PR #139 review).
 *
 * The installation secret keys `vaultStoreReference`'s HMAC so the opaque
 * `vault://` reference cannot be reconstructed offline from a guessable host
 * path. Unlike the device id it has NO empty/predictable escape hatch: the
 * only env override (for deterministic tests) is honoured solely when it is a
 * full 32-hex key, so it can never weaken the secret. It lives in the
 * device-local config, is generated once, and self-heals when corrupt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { setSecret, secretsDir } from "../../src/core/brain/secrets/store.ts";
import { loadOrCreateKey } from "../../src/core/brain/secrets/crypto.ts";
import {
  clearHeldKey,
  SecretStoreLockedError,
  wrapKeyfile,
} from "../../src/core/brain/secrets/envelope.ts";
import {
  INSTALLATION_SECRET_ENV_KEY,
  isValidInstallationSecret,
  resolveInstallationSecret,
  vaultStoreReference,
  VAULT_STORE_REF_PREFIX,
} from "../../src/core/config.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { SecretReferenceError } from "../../src/core/secret-ref.ts";
// The entry scripts load the named-secret resolver at startup, which is
// what fills config's resolver port; the `$secret:` cases below need the
// same wiring in this process.
import "../../src/core/secret-resolver.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

const INSTALLED_REF = "$secret:installation_secret";
const ABSENT_REF = "$secret:absent_name";

/** A stored value of the wrong shape: not 32 lowercase hex characters. */
const CORRUPT_VALUE = "not-a-valid-secret";

const HEX32 = /^[0-9a-f]{32}$/;

let configHome: string;
let configPath: string;
let savedSecret: string | undefined;
let savedDeviceId: string | undefined;
const custodyVaults: string[] = [];

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "o2b-install-secret-"));
  configPath = join(configHome, "config.yaml");
  savedSecret = process.env[INSTALLATION_SECRET_ENV_KEY];
  savedDeviceId = process.env["O2B_DEVICE_ID"];
  delete process.env[INSTALLATION_SECRET_ENV_KEY];
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  for (const vault of custodyVaults.splice(0)) rmSync(vault, { recursive: true, force: true });
  if (savedSecret === undefined) delete process.env[INSTALLATION_SECRET_ENV_KEY];
  else process.env[INSTALLATION_SECRET_ENV_KEY] = savedSecret;
  if (savedDeviceId === undefined) delete process.env["O2B_DEVICE_ID"];
  else process.env["O2B_DEVICE_ID"] = savedDeviceId;
});

describe("resolveInstallationSecret", () => {
  test("generates a non-empty 32-hex secret on first use and persists it", () => {
    const secret = resolveInstallationSecret(configPath);
    expect(secret).not.toBe("");
    expect(secret).toMatch(HEX32);
    expect(readFileSync(configPath, "utf8")).toContain(`installation_secret: "${secret}"`);
  });

  test("returns the same secret on every subsequent call (stable)", () => {
    const first = resolveInstallationSecret(configPath);
    const second = resolveInstallationSecret(configPath);
    expect(second).toBe(first);
  });

  test("regenerates when the stored value is corrupt or the wrong shape", () => {
    atomicWriteFileSync(configPath, `installation_secret: ${JSON.stringify(CORRUPT_VALUE)}\n`);
    const secret = resolveInstallationSecret(configPath);
    expect(secret).toMatch(HEX32);
    expect(readFileSync(configPath, "utf8")).toContain(`installation_secret: "${secret}"`);
  });

  test("honours the env override only when it is a full 32-hex key", () => {
    process.env[INSTALLATION_SECRET_ENV_KEY] = "0123456789abcdef0123456789abcdef";
    expect(resolveInstallationSecret(configPath)).toBe("0123456789abcdef0123456789abcdef");
  });

  test("ignores an empty or predictable env override and generates a real key", () => {
    process.env[INSTALLATION_SECRET_ENV_KEY] = "";
    const empty = resolveInstallationSecret(configPath);
    expect(empty).not.toBe("");
    expect(empty).toMatch(HEX32);

    rmSync(configPath, { force: true });
    process.env[INSTALLATION_SECRET_ENV_KEY] = "short";
    const short = resolveInstallationSecret(configPath);
    expect(short).not.toBe("short");
    expect(short).toMatch(HEX32);
  });

  test("isValidInstallationSecret accepts 32-hex only", () => {
    expect(isValidInstallationSecret("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidInstallationSecret("")).toBe(false);
    expect(isValidInstallationSecret("short")).toBe(false);
    expect(isValidInstallationSecret("0123456789ABCDEF0123456789ABCDEF")).toBe(false); // uppercase
    expect(isValidInstallationSecret("0123456789abcdef0123456789abcdefff")).toBe(false); // too long
  });

  // ----- Reference routing (trust-surface-hardening, t_e5807974 / B2) --------
  //
  // A persisted value written as a `$secret:NAME` reference resolves through
  // the custody store of the vault the caller passes. Plain values keep
  // today's path byte-identically, and an unresolvable reference refuses
  // with the named resolver error instead of self-healing a fresh key over
  // the reference (which would silently change every vault:// reference).
  describe("reference routing", () => {
    const STORED_KEY = randomBytes(16).toString("hex");
    const NOW = new Date("2026-06-05T10:00:00Z");

    function storeInstallationKey(value: string = STORED_KEY): string {
      const vault = mkdtempSync(join(tmpdir(), "o2b-install-custody-"));
      custodyVaults.push(vault);
      mkdirSync(join(vault, "Brain"), { recursive: true });
      setSecret(vault, {
        name: "installation_secret",
        value,
        agent: "tester",
        now: NOW,
      });
      return vault;
    }

    test("a reference value resolves through the custody store", () => {
      const vault = storeInstallationKey();
      atomicWriteFileSync(configPath, `installation_secret: "${INSTALLED_REF}"\n`);
      expect(resolveInstallationSecret(configPath, vault)).toBe(STORED_KEY);
    });

    test("an unresolvable reference refuses with the named error, never self-heals", () => {
      const vault = storeInstallationKey();
      atomicWriteFileSync(configPath, `installation_secret: "${ABSENT_REF}"\n`);
      expect(() => resolveInstallationSecret(configPath, vault)).toThrow(SecretReferenceError);
      // The reference is still in the config: no fresh key was written over it.
      expect(readFileSync(configPath, "utf8")).toContain("absent_name");
    });

    test("a reference that resolves to a non-key value refuses by name, never self-heals", () => {
      // The reference RESOLVES - the store answers - but what it answers
      // is not a 32-hex key. This is the case the shipped code got wrong:
      // the invalid value read as a miss and the self-heal minted a fresh
      // key over the persisted reference.
      const vault = storeInstallationKey("not-a-32-hex-key");
      atomicWriteFileSync(configPath, `installation_secret: "${INSTALLED_REF}"\n`);
      expect(() => resolveInstallationSecret(configPath, vault)).toThrow(SecretReferenceError);
      // The reference survives untouched, and the HMAC input never rotated.
      expect(readFileSync(configPath, "utf8")).toContain("$secret:installation_secret");
    });

    test("a persisted reference refuses by name when no vault is available, never self-heals", () => {
      // The exported signature allows omitting the vault; that must turn
      // into the named refusal, not into a fresh key over the reference.
      atomicWriteFileSync(configPath, `installation_secret: "${INSTALLED_REF}"\n`);
      expect(() => resolveInstallationSecret(configPath)).toThrow(SecretReferenceError);
      expect(readFileSync(configPath, "utf8")).toContain("$secret:installation_secret");
    });

    test("a reference that resolves to a locked store-held key refuses by name", () => {
      const vault = storeInstallationKey();
      // Wrap the keyfile and drop this process's holder: the store is
      // locked, so the reference cannot resolve.
      const kp = join(secretsDir(vault), "keyfile");
      wrapKeyfile(kp, fakeCredential("install-wrap-", "phrase-8e31"), loadOrCreateKey(kp));
      clearHeldKey(kp);
      atomicWriteFileSync(configPath, `installation_secret: "${INSTALLED_REF}"\n`);
      expect(() => resolveInstallationSecret(configPath, vault)).toThrow(SecretStoreLockedError);
      expect(readFileSync(configPath, "utf8")).toContain("$secret:installation_secret");
    });

    test("plain values keep resolving byte-identically with a vault passed", () => {
      const vault = storeInstallationKey();
      const secret = resolveInstallationSecret(configPath);
      expect(resolveInstallationSecret(configPath, vault)).toBe(secret);
      expect(secret).toMatch(HEX32);
    });
  });
});

describe("vaultStoreReference (keyed HMAC)", () => {
  test("emits vault:// plus 32 hex chars (128 bits)", () => {
    atomicWriteFileSync(configPath, "vault_path: /tmp/vault\n");
    const ref = vaultStoreReference("/some/vault", configPath);
    expect(ref.startsWith(VAULT_STORE_REF_PREFIX)).toBe(true);
    expect(ref).toMatch(/^vault:\/\/[0-9a-f]{32}$/);
  });

  test("is stable for the same vault and differs across vaults", () => {
    atomicWriteFileSync(configPath, "vault_path: /tmp/vault\n");
    expect(vaultStoreReference("/a/vault", configPath)).toBe(
      vaultStoreReference("/a/vault", configPath),
    );
    expect(vaultStoreReference("/a/vault", configPath)).not.toBe(
      vaultStoreReference("/b/vault", configPath),
    );
  });

  /**
   * The pinned digest is HMAC over the POSIX absolute path `/tmp/vault-kat`.
   * On Windows `resolve()` turns that into `<drive>:\tmp\vault-kat`, a
   * different (and drive-dependent) input, so there the expectation is the
   * same recipe computed over the host's absolute form: still a known answer
   * for the recipe, just not a byte-pinned constant.
   */
  const KAT_REF =
    process.platform === "win32"
      ? `vault://${createHmac("sha256", "0123456789abcdef0123456789abcdef")
          .update(resolve("/tmp/vault-kat"))
          .digest("hex")
          .slice(0, 32)}`
      : "vault://c8bef611f8e689165309bdecffb0f292";

  test("known-answer: HMAC-SHA256(secret, abs path) with an injected key", () => {
    process.env[INSTALLATION_SECRET_ENV_KEY] = "0123456789abcdef0123456789abcdef";
    expect(vaultStoreReference("/tmp/vault-kat", configPath)).toBe(KAT_REF);
  });

  test("reference does not depend on device id (device_id opt-out cannot weaken it)", () => {
    process.env[INSTALLATION_SECRET_ENV_KEY] = "0123456789abcdef0123456789abcdef";
    process.env["O2B_DEVICE_ID"] = "";
    const withEmptyDevice = vaultStoreReference("/tmp/vault-kat", configPath);
    process.env["O2B_DEVICE_ID"] = "abcd1234";
    const withRealDevice = vaultStoreReference("/tmp/vault-kat", configPath);
    expect(withEmptyDevice).toBe(withRealDevice);
    expect(withEmptyDevice).toBe(KAT_REF);
  });

  test("threads the referenced vault so a reference key resolves through its custody store", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-install-custody-"));
    custodyVaults.push(vault);
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const storedKey = randomBytes(16).toString("hex");
    setSecret(vault, {
      name: "installation_secret",
      value: storedKey,
      agent: "tester",
      now: new Date("2026-06-05T10:00:00Z"),
    });
    atomicWriteFileSync(configPath, `installation_secret: "${INSTALLED_REF}"\n`);
    const expected =
      VAULT_STORE_REF_PREFIX +
      createHmac("sha256", storedKey).update(resolve(vault)).digest("hex").slice(0, 32);
    expect(vaultStoreReference(vault, configPath)).toBe(expected);
  });
});
