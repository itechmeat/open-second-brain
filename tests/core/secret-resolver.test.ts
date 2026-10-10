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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const IS_WINDOWS = process.platform === "win32";
import { join } from "node:path";

import { listSecrets, secretsDir, setSecret } from "../../src/core/brain/secrets/store.ts";
import { lockSecretKeyfile, unlockSecretKeyfile } from "../../src/core/brain/secrets/store.ts";
import { SecretReferenceError } from "../../src/core/secret-ref.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { redactErrorForCaller } from "../../src/mcp/error-redaction.ts";
import {
  listNamedSecretAvailability,
  resolveNamedSecret,
  resolvedSecretLiterals,
  secretProvider,
} from "../../src/core/secret-resolver.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

const NOW = new Date("2026-06-05T10:00:00Z");
const STORE_VALUE = fakeCredential("store", "-value-", "42f1c9");
const ENV_VALUE = fakeCredential("env", "-value-", "77b3d0");
const REF = "$secret:embed_key";

let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "embed_key",
  "fallback_key",
  "ENV_CASE",
  "env_case",
  "QUIET_ENV",
  "OPEN_SECOND_BRAIN_CONFIG",
] as const;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-secret-resolver-"));
  configPath = join(vault, "..", "o2b-secret-resolver-config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configPath, { force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Point the default config discovery at a one-line config file. */
function writeDeviceConfig(body: string): void {
  writeFileSync(configPath, body, "utf8");
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
}

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

  test("a dashed store-slug reference resolves the entry `set` wrote", () => {
    // Write-side trust review: the store accepts `set openai-key` while the
    // old reference grammar refused `$secret:openai-key` outright - the two
    // name spaces must agree.
    setSecret(vault, { name: "openai-key", value: STORE_VALUE, agent: "tester", now: NOW });
    expect(resolveNamedSecret(vault, "$secret:openai-key")).toBe(STORE_VALUE);
  });

  test("store lookup normalizes the reference body; the env fallback stays case-sensitive", () => {
    setSecret(vault, { name: "brave", value: STORE_VALUE, agent: "tester", now: NOW });
    // The store holds `brave`; the upper-case reference resolves through it,
    // and the store shadows any same-named environment variable.
    process.env["brave"] = ENV_VALUE;
    expect(resolveNamedSecret(vault, "$secret:BRAVE")).toBe(STORE_VALUE);

    // The environment leg keeps its case rules: an upper-case env var
    // answers an upper-case reference, a lower-case env var does not.
    process.env["ENV_CASE"] = ENV_VALUE;
    expect(resolveNamedSecret(vault, "$secret:ENV_CASE")).toBe(ENV_VALUE);
    delete process.env["ENV_CASE"];
    process.env["env_case"] = ENV_VALUE;
    // Windows resolves environment names case-insensitively at the OS level,
    // so the lower-case variable answers the upper-case reference there; the
    // case-sensitive contract is a POSIX property and is pinned only where
    // the platform honours it.
    if (!IS_WINDOWS) {
      expect(() => resolveNamedSecret(vault, "$secret:ENV_CASE")).toThrow(SecretReferenceError);
    } else {
      expect(resolveNamedSecret(vault, "$secret:ENV_CASE")).toBe(ENV_VALUE);
    }
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

describe("resolvedSecretLiterals", () => {
  test("includes the env legs of the config's references so errors scrub them", () => {
    // Write-side trust review: a reference the store does not hold resolves
    // from the environment at use time, and that value used to be invisible
    // to the egress literal set.
    writeDeviceConfig(`quiet_ref: "$secret:QUIET_ENV"\n`);
    process.env["QUIET_ENV"] = ENV_VALUE;

    const literals = resolvedSecretLiterals(vault);
    expect(literals).toContain(ENV_VALUE);
    const out = redactErrorForCaller(
      `upstream refused: ${ENV_VALUE}`,
      vault,
      TRANSPORT_REACH.remote,
      literals,
    );
    expect(out).not.toContain(ENV_VALUE);
    expect(out).toContain("***REDACTED***");
  });

  test("a store-held name excludes its env entry (the store never falls back)", () => {
    setStoreKey();
    process.env["embed_key"] = ENV_VALUE;
    writeDeviceConfig(`ref: "$secret:embed_key"\n`);

    // Store first: the use-site resolution can never answer this reference
    // from the environment, so the env value is not a resolved credential.
    expect(resolvedSecretLiterals(vault)).toEqual([STORE_VALUE]);
  });

  test("a 2-char stored value no longer blanks error text", () => {
    // The over-redaction guard: a 1-2 char literal used to substitute every
    // occurrence of those characters in the surrounding prose. The trade-off
    // (short values are not scrubbed) is stated in the source.
    setSecret(vault, { name: "tiny", value: "ok", agent: "tester", now: NOW });
    writeDeviceConfig(`tiny_ref: "$secret:tiny"\n`);

    const literals = resolvedSecretLiterals(vault);
    expect(literals).toEqual(["ok"]);
    // Neutral prose: no secret-shaped key name for the structural passes to
    // react to, so the assertion isolates the literal mechanism.
    const out = redactErrorForCaller(
      "found ok and ok here",
      vault,
      TRANSPORT_REACH.remote,
      literals,
    );
    expect(out).toBe("found ok and ok here");
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
