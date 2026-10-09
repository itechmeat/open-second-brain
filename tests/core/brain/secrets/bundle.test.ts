/**
 * Passphrase-encrypted credential bundles (t_592d9e91): export the
 * store's entries as a single schema-versioned envelope whose values are
 * re-encrypted under a key the passphrase derives through the keyfile
 * envelope's KDF, and import one back - into this vault or a fresh one -
 * with exactness on name collisions and nothing written on a refusal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLE_REFUSAL_CODES,
  bundleEgressScanTree,
  bundleFromEgressScan,
  exportSecretBundle,
  importSecretBundle,
  SECRET_BUNDLE_SCHEMA_VERSION,
  SecretBundleError,
} from "../../../../src/core/brain/secrets/bundle.ts";
import {
  listSecrets,
  resolveSecretReadOnly,
  secretsDir,
  setSecret,
} from "../../../../src/core/brain/secrets/store.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

const NOW = new Date("2026-06-05T10:00:00Z");
const LATER = new Date("2026-06-05T11:00:00Z");
const CTX = { agent: "tester", now: NOW };
const PASSPHRASE = fakeCredential("bundle-pass", "-phrase-", "42");
const WRONG_PASSPHRASE = fakeCredential("bundle-wrong", "-phrase-", "42");
const VALUE_A = fakeCredential("sk-bundle-", "alpha-9f8e7d6c");
const VALUE_B = fakeCredential("tok-bundle-", "beta-5a5a5a5a");

let vault: string;
let other: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bundle-"));
  other = mkdtempSync(join(tmpdir(), "o2b-bundle-other-"));
  for (const root of [vault, other]) mkdirSync(join(root, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

function seed(root: string): void {
  setSecret(root, {
    name: "alpha-key",
    value: VALUE_A,
    envVar: "ALPHA_KEY",
    allow: ["curl *"],
    agent: "tester",
    now: NOW,
  });
  setSecret(root, {
    name: "beta-key",
    value: VALUE_B,
    envVar: "BETA_KEY",
    allow: [],
    agent: "tester",
    now: NOW,
  });
}

describe("the credential bundle", () => {
  test("export then import into a fresh vault restores names, env vars and allowlists", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    const result = importSecretBundle(other, bundle, {
      passphrase: PASSPHRASE,
      replace: false,
      agent: "tester",
      now: LATER,
    });
    expect(result.imported.toSorted()).toEqual(["alpha-key", "beta-key"]);
    expect(result.replaced).toEqual([]);
    const restored = listSecrets(other);
    expect(restored).toHaveLength(2);
    expect(restored.find((s) => s.name === "alpha-key")).toMatchObject({
      env_var: "ALPHA_KEY",
      allow: ["curl *"],
    });
    expect(restored.find((s) => s.name === "beta-key")).toMatchObject({
      env_var: "BETA_KEY",
      allow: [],
    });
    expect(resolveSecretReadOnly(other, "alpha-key").value).toBe(VALUE_A);
    expect(resolveSecretReadOnly(other, "beta-key").value).toBe(VALUE_B);
  });

  test("a wrong passphrase refuses by name and writes nothing to the target store", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    try {
      importSecretBundle(other, bundle, {
        passphrase: WRONG_PASSPHRASE,
        replace: false,
        agent: "tester",
        now: LATER,
      });
      throw new Error("expected the passphrase refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretBundleError);
      expect((err as SecretBundleError).code).toBe(BUNDLE_REFUSAL_CODES.passphrase);
    }
    expect(listSecrets(other)).toHaveLength(0);
    expect(existsSync(join(secretsDir(other), "secrets.json"))).toBe(false);
  });

  test("import refuses an existing name without --replace; --replace overwrites exactly", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    const older = fakeCredential("older", "-value-", "1");
    setSecret(other, {
      name: "alpha-key",
      value: older,
      envVar: "OLD_KEY",
      allow: [],
      agent: "tester",
      now: NOW,
    });
    try {
      importSecretBundle(other, bundle, {
        passphrase: PASSPHRASE,
        replace: false,
        agent: "tester",
        now: LATER,
      });
      throw new Error("expected the collision refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretBundleError);
      expect((err as SecretBundleError).code).toBe(BUNDLE_REFUSAL_CODES.nameExists);
      expect((err as SecretBundleError).message).toContain("alpha-key");
    }
    // Exactness: the refused import changed nothing.
    expect(resolveSecretReadOnly(other, "alpha-key").value).toBe(older);
    expect(listSecrets(other)).toHaveLength(1);

    const result = importSecretBundle(other, bundle, {
      passphrase: PASSPHRASE,
      replace: true,
      agent: "tester",
      now: LATER,
    });
    expect(result.replaced).toEqual(["alpha-key"]);
    expect(result.imported.toSorted()).toEqual(["alpha-key", "beta-key"]);
    expect(resolveSecretReadOnly(other, "alpha-key").value).toBe(VALUE_A);
    expect(listSecrets(other)).toHaveLength(2);
  });

  test("import validates allow patterns exactly as `set` refuses them", () => {
    // The allow list rides in the clear, so a bundle rewritten in transit
    // cannot land entries the store's own writer would refuse - and a
    // non-string pattern cannot reach the exec allowlist matcher.
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX) as unknown as {
      entries: Record<string, { allow: unknown[] }>;
    };
    for (const bad of [[""], ["   "]]) {
      const tampered = structuredClone(bundle);
      tampered.entries["beta-key"]!.allow = bad;
      try {
        importSecretBundle(other, tampered, {
          passphrase: PASSPHRASE,
          replace: false,
          agent: "tester",
          now: LATER,
        });
        throw new Error(`expected the allow-pattern refusal for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretBundleError);
        expect((err as SecretBundleError).code).toBe(BUNDLE_REFUSAL_CODES.entry);
      }
      expect(listSecrets(other)).toHaveLength(0);
    }
    const typed = structuredClone(bundle);
    typed.entries["beta-key"]!.allow = [42];
    expect(() =>
      importSecretBundle(other, typed, {
        passphrase: PASSPHRASE,
        replace: false,
        agent: "tester",
        now: LATER,
      }),
    ).toThrow(SecretBundleError);
    expect(listSecrets(other)).toHaveLength(0);
    // A valid pattern trims exactly as `set` trims it.
    const padded = structuredClone(bundle);
    padded.entries["beta-key"]!.allow = ["  curl *  "];
    importSecretBundle(other, padded, {
      passphrase: PASSPHRASE,
      replace: false,
      agent: "tester",
      now: LATER,
    });
    expect(listSecrets(other).find((s) => s.name === "beta-key")?.allow).toEqual(["curl *"]);
  });

  test("the exported bytes carry none of the values or the passphrase; KDF rides inside", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(VALUE_A);
    expect(serialized).not.toContain(VALUE_B);
    expect(serialized).not.toContain(PASSPHRASE);
    // Schema version and wall clock top the envelope; the KDF parameters
    // travel inside it so old exports stay readable as the cost curve moves.
    expect(bundle.version).toBe(SECRET_BUNDLE_SCHEMA_VERSION);
    expect(typeof bundle.generated_at).toBe("string");
    expect(bundle.kdf.algo).toBe("scrypt");
    expect(bundle.kdf.n).toBe(2 ** 15);
    // The egress scan tree is exactly the non-ciphertext inventory: names
    // and mappings visible to the guard as an ARRAY (never credential-
    // shaped mapping keys), the kdf salt excluded, values absent.
    const scanTree = bundleEgressScanTree(bundle);
    const scanned = JSON.stringify(scanTree);
    expect(scanned).toContain("alpha-key");
    expect(scanned).toContain("ALPHA_KEY");
    expect(scanned).not.toContain("ciphertext");
    expect(scanned).not.toContain("salt");
    const scannedEntries = scanTree.entries as Array<{ name: string }>;
    expect(scannedEntries.map((e) => e.name).toSorted()).toEqual(["alpha-key", "beta-key"]);
    // The merge re-attaches the sealed values; a clean scan round-trips.
    const merged = bundleFromEgressScan(bundle, scanTree);
    expect(merged.entries["alpha-key"]!.value).toEqual(bundle.entries["alpha-key"]!.value);
  });

  test("the merge refuses when the guard rewrote an entry identifier", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    const scanTree = bundleEgressScanTree(bundle) as {
      entries: Array<Record<string, unknown>>;
    };
    scanTree.entries[0]!["name"] = fakeCredential("rewritten", "-name-", "9");
    try {
      bundleFromEgressScan(bundle, scanTree);
      throw new Error("expected the identifier-rewrite refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretBundleError);
      expect((err as SecretBundleError).code).toBe(BUNDLE_REFUSAL_CODES.entry);
    }
  });

  test("audit records the export and the import with no values", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    importSecretBundle(other, bundle, {
      passphrase: PASSPHRASE,
      replace: false,
      agent: "tester",
      now: LATER,
    });
    for (const [root, action] of [
      [vault, "secret_bundle_exported"],
      [other, "secret_bundle_imported"],
    ] as const) {
      const auditDir = join(root, "Brain", "log", "secret-custody");
      const raw = readdirSync(auditDir)
        .map((f) => readFileSync(join(auditDir, f), "utf8"))
        .join("");
      const lines = raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { action: string });
      expect(lines.map((l) => l.action)).toContain(action);
      expect(raw).not.toContain(VALUE_A);
      expect(raw).not.toContain(PASSPHRASE);
    }
  });

  test("an unknown bundle version or kdf algo refuses by name", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    for (const [field, mutate, code] of [
      [
        "version",
        (b: Record<string, unknown>) => void (b["version"] = (b["version"] as number) + 1),
        BUNDLE_REFUSAL_CODES.version,
      ],
      [
        "algo",
        (b: Record<string, unknown>) =>
          void ((b["kdf"] as Record<string, unknown>)["algo"] = "argon2id"),
        BUNDLE_REFUSAL_CODES.kdfAlgo,
      ],
    ] as const) {
      const tampered = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
      mutate(tampered);
      try {
        importSecretBundle(other, tampered, {
          passphrase: PASSPHRASE,
          replace: false,
          agent: "tester",
          now: LATER,
        });
        throw new Error(`expected the ${field} refusal`);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretBundleError);
        expect((err as SecretBundleError).code).toBe(code);
      }
    }
    expect(listSecrets(other)).toHaveLength(0);
  });

  test("a crafted kdf cost block refuses by name before scrypt allocates", () => {
    seed(vault);
    const bundle = exportSecretBundle(vault, PASSPHRASE, CTX);
    // The bundle's kdf block rides in the clear, so a rewritten one is
    // the same unbounded-cost knob a hand-edited keyfile envelope is;
    // the same build curve bounds it.
    const absurd = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    (absurd["kdf"] as Record<string, unknown>)["n"] = 2 ** 31;
    (absurd["kdf"] as Record<string, unknown>)["maxmem"] = 10 ** 12;
    try {
      importSecretBundle(other, absurd, {
        passphrase: PASSPHRASE,
        replace: false,
        agent: "tester",
        now: LATER,
      });
      throw new Error("expected the kdf-cost refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretBundleError);
      expect((err as SecretBundleError).code).toBe(BUNDLE_REFUSAL_CODES.kdfCost);
    }
    expect(listSecrets(other)).toHaveLength(0);
  });
});
