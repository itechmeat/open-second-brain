/**
 * The `vault_path` field when the installation secret resolves through the
 * vault's custody store and the store refuses.
 *
 * The field is the one value forty-five tools emit into model context
 * precisely so host paths do not travel there; its contract says it
 * degrades to a reason instead of raising. A `$secret:NAME` installation
 * secret added two more refusals a locked or unresolvable store produces -
 * both named errors whose own messages carry paths or raw reference
 * values - and each must degrade through the same mapping, with a
 * path-free reason, exactly like the unreadable-config condition beside
 * it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKey } from "../../src/core/brain/secrets/crypto.ts";
import { clearHeldKey, wrapKeyfile } from "../../src/core/brain/secrets/envelope.ts";
import { secretsDir, setSecret } from "../../src/core/brain/secrets/store.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";
// Registers the named-secret resolver port config resolves references
// through; without it the reference branch takes the unwired, generic
// refusal and the per-cause degradations below cannot be exercised.
import "../../src/core/secret-resolver.ts";
import {
  hostPathReference,
  SECRET_REFERENCE_UNRESOLVED_REASON,
  SECRET_STORE_KEYFILE_MISSING_REASON,
  SECRET_STORE_LOCKED_REASON,
} from "../../src/mcp/vault-path-field.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-vault-path-field-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  for (const k of ["O2B_INSTALLATION_SECRET", "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS"]) {
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

function configWithInstallationSecret(value: string): void {
  writeFileSync(configPath, `installation_secret: "${value}"\n`, "utf8");
}

describe("vault_path on a $secret: installation secret", () => {
  test("a locked custody store degrades to the named locked reason", () => {
    configWithInstallationSecret("$secret:install_key");
    setSecret(vault, {
      name: "install_key",
      value: fakeCredential("stored-install-", "key-44af"),
      agent: "tester",
      now: new Date("2026-06-05T10:00:00Z"),
    });
    const keyPath = join(secretsDir(vault), "keyfile");
    wrapKeyfile(keyPath, fakeCredential("vpf-wrap", "-phrase-", "42"), loadOrCreateKey(keyPath));
    clearHeldKey(keyPath);

    const field = hostPathReference(vault, { configPath });
    expect(field).toEqual({ error: SECRET_STORE_LOCKED_REASON });
    // The redaction contract holds in the degraded shape: neither the
    // vault path nor the keyfile path travels.
    expect(JSON.stringify(field)).not.toContain(vault);
    expect(JSON.stringify(field)).not.toContain("keyfile");
  });

  test("an unresolvable reference degrades to the named reference reason", () => {
    configWithInstallationSecret("$secret:absent_install_key");
    const field = hostPathReference(vault, { configPath });
    expect(field).toEqual({ error: SECRET_REFERENCE_UNRESOLVED_REASON });
    expect(JSON.stringify(field)).not.toContain(vault);
    expect(JSON.stringify(field)).not.toContain("absent_install_key");
  });

  test("a missing keyfile over held entries degrades to the named missing-keyfile reason", () => {
    // The locked refusal's sibling state on the same resolution path: the
    // read-only resolve now refuses instead of minting a fresh key over
    // the surviving ciphertext, and the field degrades it like every other
    // named store refusal.
    configWithInstallationSecret("$secret:install_key");
    setSecret(vault, {
      name: "install_key",
      value: fakeCredential("stored-install-", "key-91cd"),
      agent: "tester",
      now: new Date("2026-06-05T10:00:00Z"),
    });
    const keyPath = join(secretsDir(vault), "keyfile");
    rmSync(keyPath);

    const field = hostPathReference(vault, { configPath });
    expect(field).toEqual({ error: SECRET_STORE_KEYFILE_MISSING_REASON });
    // The refusal left no custody state behind.
    expect(existsSync(keyPath)).toBe(false);
    expect(JSON.stringify(field)).not.toContain(vault);
  });

  test("a plain installation secret still resolves to the opaque reference", () => {
    configWithInstallationSecret("a".repeat(32));
    const field = hostPathReference(vault, { configPath });
    expect(typeof field).toBe("string");
    expect(field as string).toMatch(/^vault:\/\/[0-9a-f]{32}$/);
  });
});
