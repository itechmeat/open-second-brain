/**
 * The research-pool measurement reads the vault-resolved configuration
 * (PR #244 review M10/L1).
 *
 * `measureDataOwnership` handed `resolveResearchPoolEnv` raw
 * `process.env` and no vault, so a key env written as a `$secret:NAME`
 * reference was taken as-is - the raw reference counted as a CONFIGURED
 * research key in the ownership statement, and the v1.78.0 claim that
 * "research names the refusal instead of quietly yielding an empty pool"
 * was not true on the live path. The measure now passes the vault, so a
 * reference resolves the way the runtime resolves it (custody store of
 * this vault first, environment fallback), and a reference that resolves
 * nowhere is reported as unchecked with the resolver's named error - the
 * refusal names the unresolved reference - never as configured.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCredential } from "../../../tests/helpers/fake-credentials.ts";
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
