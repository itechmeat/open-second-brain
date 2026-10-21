import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveCounterpartyBriefEnabled,
  resolveCounterpartyBriefTriggers,
  resolveEntityFactsContextPack,
} from "../../src/core/config.ts";

/** Env keys these tests own outright, whatever the outer shell set. */
const OWNED_ENV = [
  "OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED",
  "OPEN_SECOND_BRAIN_ENTITY_FACTS_CONTEXT_PACK",
] as const;

let tmp: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-counterparty-"));
  configPath = join(tmp, "config.yaml");
  for (const key of OWNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const body = Object.entries(entries)
    .map(([k, v]) => `${k}: "${v}"`)
    .join("\n");
  writeFileSync(configPath, body + "\n");
}

describe("resolveCounterpartyBriefEnabled", () => {
  test("defaults to false with no config and no env", () => {
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(false);
  });

  test("turns on from the config key", () => {
    writeConfig({ counterparty_brief_enabled: "true" });
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(true);
  });

  test("the env override wins over the config key", () => {
    writeConfig({ counterparty_brief_enabled: "false" });
    process.env["OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED"] = "true";
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(true);
    process.env["OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED"] = "1";
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(true);
  });

  test("an env override can hold the gate off against an on config", () => {
    writeConfig({ counterparty_brief_enabled: "true" });
    process.env["OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED"] = "0";
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(false);
  });

  test("only the truthy literals turn it on", () => {
    writeConfig({ counterparty_brief_enabled: "yes" });
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(false);
  });

  test("no resolver throws on a malformed config file", () => {
    writeFileSync(configPath, "{{{ not: [yaml\n:::\n\tcounterparty_brief_enabled\n");
    expect(resolveCounterpartyBriefEnabled(configPath)).toBe(false);
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual([]);
    expect(resolveEntityFactsContextPack(configPath)).toBe(false);
  });
});

describe("resolveCounterpartyBriefTriggers", () => {
  test("answers an empty list when the key is absent", () => {
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual([]);
  });

  test("answers an empty list when the key is blank", () => {
    writeConfig({ counterparty_brief_triggers: "" });
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual([]);
    writeConfig({ counterparty_brief_triggers: "  ,  , " });
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual([]);
  });

  test("reads a comma-separated list, trimming each entry", () => {
    writeConfig({ counterparty_brief_triggers: " meet , call , " });
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual(["meet", "call"]);
  });

  test("normalizes each entry to NFC", () => {
    // The stored entry is "cafe" plus a combining acute accent (NFD); the
    // resolver answers the composed form so caller-side comparisons against
    // NFC-normalized text match.
    writeConfig({ counterparty_brief_triggers: "cafe\u0301" });
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual(["caf\u00e9"]);
  });

  test("a bracket-shaped YAML list is malformed and answers an empty list", () => {
    // The flat config parser cannot represent a real YAML list; the value
    // arrives as the literal string "[meet, call]". Treating it as tokens
    // would ship tokens no prompt ever contains, so the resolver answers
    // the empty list (the brief stays inert, which is the safe direction).
    writeConfig({ counterparty_brief_triggers: "[meet, call]" });
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual([]);
  });

  test("duplicate entries are kept as declared, order preserved", () => {
    writeConfig({ counterparty_brief_triggers: "meet, call, meet" });
    expect(resolveCounterpartyBriefTriggers(configPath)).toEqual(["meet", "call", "meet"]);
  });
});

describe("resolveEntityFactsContextPack", () => {
  test("defaults to false with no config and no env", () => {
    expect(resolveEntityFactsContextPack(configPath)).toBe(false);
  });

  test("turns on from the config key", () => {
    writeConfig({ entity_facts_context_pack: "true" });
    expect(resolveEntityFactsContextPack(configPath)).toBe(true);
  });

  test("the env override wins over the config key", () => {
    writeConfig({ entity_facts_context_pack: "false" });
    process.env["OPEN_SECOND_BRAIN_ENTITY_FACTS_CONTEXT_PACK"] = "1";
    expect(resolveEntityFactsContextPack(configPath)).toBe(true);
  });

  test("only the truthy literals turn it on", () => {
    writeConfig({ entity_facts_context_pack: "on" });
    expect(resolveEntityFactsContextPack(configPath)).toBe(false);
  });
});
