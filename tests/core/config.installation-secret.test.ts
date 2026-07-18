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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INSTALLATION_SECRET_ENV_KEY,
  isValidInstallationSecret,
  resolveInstallationSecret,
  vaultStoreReference,
  VAULT_STORE_REF_PREFIX,
} from "../../src/core/config.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

const HEX32 = /^[0-9a-f]{32}$/;

let configHome: string;
let configPath: string;
let savedSecret: string | undefined;
let savedDeviceId: string | undefined;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "o2b-install-secret-"));
  configPath = join(configHome, "config.yaml");
  savedSecret = process.env[INSTALLATION_SECRET_ENV_KEY];
  savedDeviceId = process.env["O2B_DEVICE_ID"];
  delete process.env[INSTALLATION_SECRET_ENV_KEY];
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
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
    atomicWriteFileSync(configPath, 'installation_secret: "not-a-valid-secret"\n');
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

  test("known-answer: HMAC-SHA256(secret, abs path) with an injected key", () => {
    process.env[INSTALLATION_SECRET_ENV_KEY] = "0123456789abcdef0123456789abcdef";
    expect(vaultStoreReference("/tmp/vault-kat", configPath)).toBe(
      "vault://c8bef611f8e689165309bdecffb0f292",
    );
  });

  test("reference does not depend on device id (device_id opt-out cannot weaken it)", () => {
    process.env[INSTALLATION_SECRET_ENV_KEY] = "0123456789abcdef0123456789abcdef";
    process.env["O2B_DEVICE_ID"] = "";
    const withEmptyDevice = vaultStoreReference("/tmp/vault-kat", configPath);
    process.env["O2B_DEVICE_ID"] = "abcd1234";
    const withRealDevice = vaultStoreReference("/tmp/vault-kat", configPath);
    expect(withEmptyDevice).toBe(withRealDevice);
    expect(withEmptyDevice).toBe("vault://c8bef611f8e689165309bdecffb0f292");
  });
});
