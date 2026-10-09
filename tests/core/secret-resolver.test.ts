/**
 * The named-secret resolver (trust-surface-hardening, t_e5807974 /
 * Lane B1): a custody-store-backed SecretProvider with env fallback
 * behind the existing `$secret:` syntax.
 *
 * Precedence is store first, env fallback - EXCEPT a name the store
 * holds under a locked envelope, which surfaces the named locked-store
 * error rather than silently answering from the environment (a silent
 * fallback would hide the locked state). Resolution is read-only: no
 * `last_used_at` stamp, no exec audit record, no store-file mutation -
 * config reads must not take the write path. A vault with no custody
 * store gains no state from resolution at all.
 *
 * Every credential-shaped string below is assembled at runtime via the
 * fake-credentials helper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSecrets, secretsDir, setSecret } from "../../src/core/brain/secrets/store.ts";
import { lockSecretKeyfile, unlockSecretKeyfile } from "../../src/core/brain/secrets/store.ts";
import { SecretReferenceError } from "../../src/core/secret-ref.ts";
import {
  listNamedSecretAvailability,
  resolveNamedSecret,
  secretProvider,
} from "../../src/core/secret-resolver.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

const NOW = new Date("2026-06-05T10:00:00Z");
const STORE_VALUE = fakeCredential("store", "-value-", "42f1c9");
const ENV_VALUE = fakeCredential("env", "-value-", "77b3d0");
const REF = "$secret:embed_key";

let vault: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["embed_key", "fallback_key"] as const;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-secret-resolver-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function storeBytes(): string {
  return readFileSync(join(secretsDir(vault), "secrets.json"), "utf8");
}

function custodyAuditRecords(): number {
  const dir = join(vault, "Brain", "log", "secret-custody");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce(
    (n, entry) => n + readFileSync(join(dir, entry), "utf8").split("\n").filter(Boolean).length,
    0,
  );
}

function setStoreKey(): void {
  setSecret(vault, { name: "embed_key", value: STORE_VALUE, agent: "tester", now: NOW });
}

describe("resolveNamedSecret", () => {
  test("resolves a store-held reference without stamping use or emitting exec audit", () => {
    setStoreKey();
    const before = storeBytes();
    const auditsBefore = custodyAuditRecords();

    expect(resolveNamedSecret(vault, REF)).toBe(STORE_VALUE);

    expect(storeBytes()).toBe(before);
    expect(custodyAuditRecords()).toBe(auditsBefore);
    expect(listSecrets(vault)[0]?.last_used_at).toBeNull();
  });

  test("falls back to the environment when the store does not hold the name", () => {
    process.env["embed_key"] = ENV_VALUE;
    expect(resolveNamedSecret(vault, REF)).toBe(ENV_VALUE);
  });

  test("a locked store surfaces the named locked error, never the env value", () => {
    setStoreKey();
    process.env["embed_key"] = ENV_VALUE;
    lockVaultStoreForTest();
    try {
      expect(() => resolveNamedSecret(vault, REF)).toThrow(/locked/);
    } finally {
      unlockVaultStoreForTest();
    }
    expect(resolveNamedSecret(vault, REF)).toBe(STORE_VALUE);
  });

  test("malformed references keep the existing SecretReferenceError behavior", () => {
    setStoreKey();
    expect(() => resolveNamedSecret(vault, "$secret:has space")).toThrow(SecretReferenceError);
    expect(() => resolveNamedSecret(vault, "$secret:absent_name")).toThrow(SecretReferenceError);
    expect(() => resolveNamedSecret(vault, REF)).not.toThrow();
  });

  test("a plain value passes through untouched", () => {
    const plain = fakeCredential("plain", "-inline-value");
    expect(resolveNamedSecret(vault, plain)).toBe(plain);
  });
});

describe("secretProvider", () => {
  test("store entries answer by name and shadow the environment", () => {
    setStoreKey();
    process.env["embed_key"] = ENV_VALUE;
    expect(secretProvider(vault)["embed_key"]).toBe(STORE_VALUE);
  });

  test("env names answer when the store does not hold them", () => {
    process.env["embed_key"] = ENV_VALUE;
    expect(secretProvider(vault)["embed_key"]).toBe(ENV_VALUE);
  });

  test("resolution through the provider does not mutate the store file", () => {
    setStoreKey();
    const before = storeBytes();
    void secretProvider(vault)["embed_key"];
    expect(storeBytes()).toBe(before);
  });

  test("an absent name reads as undefined, like any env-shaped provider", () => {
    expect(secretProvider(vault)["absent_name"]).toBeUndefined();
  });

  test("a vault without a custody store gains no state from resolution", () => {
    process.env["embed_key"] = ENV_VALUE;
    expect(existsSync(secretsDir(vault))).toBe(false);
    expect(resolveNamedSecret(vault, REF)).toBe(ENV_VALUE);
    expect(existsSync(secretsDir(vault))).toBe(false);
  });
});

describe("listNamedSecretAvailability", () => {
  test("reports availability from store metadata and env without decrypting", () => {
    setStoreKey();
    process.env["fallback_key"] = ENV_VALUE;
    const before = storeBytes();
    const availability = listNamedSecretAvailability(vault, {
      env_ref: "$secret:fallback_key",
      missing_ref: "$secret:absent_name",
      store_ref: "$secret:embed_key",
    });
    expect(availability).toEqual([
      { configKey: "env_ref", name: "fallback_key", available: true },
      { configKey: "missing_ref", name: "absent_name", available: false },
      { configKey: "store_ref", name: "embed_key", available: true },
    ]);
    expect(storeBytes()).toBe(before);
    expect(listSecrets(vault)[0]?.last_used_at).toBeNull();
  });

  test("a store-held name stays available under a locked envelope (metadata only)", () => {
    setStoreKey();
    lockVaultStoreForTest();
    try {
      const availability = listNamedSecretAvailability(vault, { ref: "$secret:embed_key" });
      expect(availability).toEqual([{ configKey: "ref", name: "embed_key", available: true }]);
    } finally {
      unlockVaultStoreForTest();
    }
  });
});

// ----- Locked-store helpers --------------------------------------------------
//
// Lane A's lock lifecycle over the store's public surface: the first
// unlock wraps a raw keyfile under the passphrase and holds the key for
// this process; the lock op clears it, so a store-held name under a
// locked envelope answers with the named locked refusal.

const VAULT_PASSPHRASE = fakeCredential("vault-", "passphrase-9d11c2");

function lockVaultStoreForTest(): void {
  unlockSecretKeyfile(vault, VAULT_PASSPHRASE, { agent: "tester", now: NOW });
  lockSecretKeyfile(vault, { agent: "tester", now: NOW });
}

function unlockVaultStoreForTest(): void {
  unlockSecretKeyfile(vault, VAULT_PASSPHRASE, { agent: "tester", now: NOW });
}
