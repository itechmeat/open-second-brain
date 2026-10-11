/**
 * The research-pool measurement reads the vault-resolved configuration
 * (PR #244 review M10/L1) and never decrypts (PR #248 review M11).
 *
 * `measureDataOwnership` handed `resolveResearchPoolEnv` raw
 * `process.env` and no vault, so a key env written as a `$secret:NAME`
 * reference was taken as-is - the raw reference counted as a CONFIGURED
 * research key in the ownership statement, and the v1.78.0 claim that
 * "research names the refusal instead of quietly yielding an empty pool"
 * was not true on the live path. The measure then passed the vault, but
 * through the DECRYPTING resolver: a presence check that decrypts turned
 * `o2b install` into a key-bearing operation, so a wrapped (locked)
 * store threw `SecretStoreLockedError` out of the statement and aborted
 * install and onboarding. The measure now answers from metadata alone -
 * the store's name set joined with the environment - and reports a store
 * it cannot read right now (locked, or missing its keyfile while
 * entries survive) as unchecked with the reason, never as configured
 * and never as a throw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCredential } from "../../../tests/helpers/fake-credentials.ts";
import {
  lockSecretKeyfile,
  setSecret,
  unlockSecretKeyfile,
} from "../../../src/core/brain/secrets/store.ts";
import { measureDataOwnership } from "../../../src/core/install/ownership-measure.ts";
import { OUTBOUND_SERVICE, OUTBOUND_STATE } from "../../../src/core/install/ownership.ts";

/** The env keys this test touches, saved and restored around each test. */
const TOUCHED_ENV_KEYS = ["TAVILY_API_KEY", "BRAVE_API_KEY", "research-key"];

/** A `$secret:` reference to a research key, spelled from parts. */
const REFERENCE = fakeCredential("$", "secret:", "research-key");

/** A fake provider key a resolved reference stands in for. */
const FAKE_RESEARCH_KEY = fakeCredential("tvly-", "fixture-key");

let saved: Record<string, string | undefined> = {};
let tempVault = "";
let configPath = "";

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tempVault = mkdtempSync(join(tmpdir(), "osb-own-research-"));
  configPath = join(tempVault, "config.yaml");
  writeFileSync(configPath, `vault: "${tempVault}"\n`);
});

afterEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempVault, { recursive: true, force: true });
});

function measured() {
  return measureDataOwnership({ vault: tempVault, configPath, adapterTargets: ["cursor"] });
}

function researchRow() {
  const row = measured().outbound_services.find((s) => s.id === OUTBOUND_SERVICE.research);
  expect(row).toBeDefined();
  return row!;
}

describe("the research outbound measurement", () => {
  test("an unresolved key reference is reported unchecked, naming the reference", () => {
    // The reference resolves nowhere: no store entry, no env fallback.
    process.env["TAVILY_API_KEY"] = REFERENCE;
    const row = researchRow();
    expect(row.state).toBe(OUTBOUND_STATE.unchecked);
    expect(row.reason ?? "").toContain("research-key");
  });

  test("a reference resolved through the vault configuration counts as configured", () => {
    // The env fallback leg: the reference body is the env name it resolves
    // through, beside the vault's custody store.
    process.env["TAVILY_API_KEY"] = REFERENCE;
    process.env["research-key"] = FAKE_RESEARCH_KEY;
    const row = researchRow();
    expect(row.state).toBe(OUTBOUND_STATE.configured);
  });

  test("an unresolved reference on one provider refuses the row for both", () => {
    process.env["BRAVE_API_KEY"] = fakeCredential("brava-", "fixture-key");
    process.env["TAVILY_API_KEY"] = REFERENCE;
    const row = researchRow();
    expect(row.state).toBe(OUTBOUND_STATE.unchecked);
    expect(row.reason ?? "").toContain("research-key");
  });

  test("a plain key still counts as configured, and a quiet machine stays absent", () => {
    process.env["TAVILY_API_KEY"] = FAKE_RESEARCH_KEY;
    expect(researchRow().state).toBe(OUTBOUND_STATE.configured);
    delete process.env["TAVILY_API_KEY"];
    expect(researchRow().state).toBe(OUTBOUND_STATE.absent);
  });
});

describe("the research measurement never decrypts (PR #248 review M11)", () => {
  const NOW = new Date("2026-06-05T10:00:00Z");
  const VAULT_PASSPHRASE = fakeCredential("vault-passphrase-", "fixture-9f8e");

  /** A custody store holding the research key, plus the reference env. */
  function storeKeyAndReference(): void {
    mkdirSync(join(tempVault, "Brain"), { recursive: true });
    setSecret(tempVault, {
      name: "research-key",
      value: FAKE_RESEARCH_KEY,
      agent: "tester",
      now: NOW,
    });
    process.env["TAVILY_API_KEY"] = REFERENCE;
  }

  test("a store-held key counts as configured through metadata alone", () => {
    storeKeyAndReference();
    expect(researchRow().state).toBe(OUTBOUND_STATE.configured);
  });

  test("a wrapped (locked) store answers unchecked with a reason, never a throw", () => {
    storeKeyAndReference();
    // Wrap the keyfile under the passphrase, then drop the held key: the
    // state after `secret unlock` followed by a process restart. The
    // measurement used to decrypt here and abort with the locked refusal.
    unlockSecretKeyfile(tempVault, VAULT_PASSPHRASE, { agent: "tester", now: NOW });
    lockSecretKeyfile(tempVault, { agent: "tester", now: NOW });
    const row = researchRow();
    expect(row.state).toBe(OUTBOUND_STATE.unchecked);
    expect(row.reason ?? "").toContain("locked");
  });
});
