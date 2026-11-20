/**
 * `discipline_report` is set one field at a time.
 *
 * The settings writer validates each single change against the settings in
 * force, so a block whose parser accepted it only whole refused the first
 * field of a fresh block as "not a brain setting", on a switched machine
 * and on one that has not switched alike, and the block could not be set
 * at all through `o2b brain settings set` or `brain_settings` (a block is
 * not a setting name of its own). A field left unset now reads as its
 * fallback, so every field can be set on its own.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { loadBrainConfig } from "../../../src/core/brain/policy/load.ts";
import { readBrainSettingsFromStore } from "../../../src/core/brain/policy/settings-source.ts";
import { setBrainSetting } from "../../../src/core/brain/policy/settings-write.ts";
import { validateBrainConfigDetailed } from "../../../src/core/brain/policy/validate.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function parse(block: unknown): {
  value: unknown;
  warnings: ReadonlyArray<string>;
} {
  const out = validateBrainConfigDetailed({ schema_version: 1, discipline_report: block });
  return { value: out.config.discipline_report, warnings: out.warnings.map((w) => w.message) };
}

describe("the block parser", () => {
  test("a field left unset reads as its fallback, with no warning", () => {
    expect(parse({ enabled: true })).toEqual({
      value: { enabled: true, timezone: "UTC", watched_paths: [], known_agents: [] },
      warnings: [],
    });
    expect(parse({ watched_paths: ["src"] }).value).toEqual({
      enabled: false,
      timezone: "UTC",
      watched_paths: ["src"],
      known_agents: [],
    });
  });

  test("a field of the wrong type still drops the whole block with a warning", () => {
    const out = parse({ enabled: "yes", timezone: "UTC" });
    expect(out.value).toBeUndefined();
    expect(out.warnings.join("\n")).toContain("discipline_report.enabled: must be a boolean");
  });
});

const human = (vault: string | null) => ({ vault, authority: "human" as const, agent: "t" });

describe("the settings writer", () => {
  test("a switched machine sets the shared fields one at a time", () => {
    env = makeStoreEnv("osb-discipline-single-");
    switchDevice(env.storeRoot);
    const first = setBrainSetting(human(env.vault), "discipline_report.enabled", true);
    expect(first).toMatchObject({ value: true, changed: true, mode: "store" });
    setBrainSetting(human(env.vault), "discipline_report.watched_paths", ["src"]);
    const config = readBrainSettingsFromStore({ configPath: env.configPath }).config;
    expect(config.discipline_report).toEqual({
      enabled: true,
      timezone: "UTC",
      watched_paths: ["src"],
      known_agents: [],
    });
  });

  test("a machine that has not switched sets one field in _brain.yaml", () => {
    env = makeStoreEnv("osb-discipline-single-legacy-");
    const first = setBrainSetting(human(env.vault), "discipline_report.enabled", true);
    expect(first).toMatchObject({ value: true, changed: true, mode: "legacy" });
    setBrainSetting(human(env.vault), "discipline_report.known_agents", ["claude"]);
    expect(loadBrainConfig(env.vault).discipline_report).toEqual({
      enabled: true,
      timezone: "UTC",
      watched_paths: [],
      known_agents: ["claude"],
    });
  });

  for (const mode of ["store", "legacy"] as const) {
    test(`an invalid value for a field the parser reads is refused, the settings unchanged (${mode})`, () => {
      env = makeStoreEnv(`osb-discipline-invalid-${mode}-`);
      if (mode === "store") switchDevice(env.storeRoot);
      setBrainSetting(human(env.vault), "discipline_report.enabled", true);
      const read = () =>
        mode === "store"
          ? readBrainSettingsFromStore({ configPath: env!.configPath }).config.discipline_report
          : loadBrainConfig(env!.vault).discipline_report;
      const before = read();
      expect(() =>
        setBrainSetting(human(env!.vault), "discipline_report.watched_paths", 42),
      ).toThrow(/must be an array/);
      expect(read()).toEqual(before);
      // A valid single field after the refusal still lands.
      setBrainSetting(human(env.vault), "discipline_report.watched_paths", ["src"]);
      expect(read()).toMatchObject({ enabled: true, watched_paths: ["src"] });
    });
  }
});
