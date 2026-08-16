/**
 * The `install:` block of `<vault>/Brain/_brain.yaml`, and the four-tier
 * resolution that reads it.
 *
 * The block exists because generated install and hook content is the one
 * output whose inputs must travel WITH the vault: two machines cloning
 * one vault must not get different hook files because one of them has a
 * stale key in its own `~/.config/open-second-brain/config.yaml`. That is
 * why the committed vault tier outranks the user tier here, which is the
 * opposite of nothing else in this tree - so it is pinned by a test that
 * drives all four layers rather than left to a comment.
 *
 * The refusal is the other half. `loadBrainConfigDetailed` already
 * distinguishes an ABSENT `_brain.yaml` (a vault nobody has initialised -
 * the next tier answers) from an UNREADABLE one (the operator's settings
 * exist and are not in force). Generated install content is a WRITER, and
 * v1.49.0 established that a writer cannot infer intent from a file it
 * could not parse: it names the parse failure and the file, and produces
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { brainConfigPath } from "../../../../src/core/brain/paths.ts";
import { validateBrainConfig } from "../../../../src/core/brain/policy/validate.ts";
import { parseBrainYaml } from "../../../../src/core/brain/yaml-parse.ts";
import {
  BRAIN_INSTALL_DEFAULTS,
  INSTALL_HOOK_TIMEOUT_SECONDS_MAX,
  INSTALL_TOOL_PROFILE_NAMES,
} from "../../../../src/core/brain/policy/blocks/install.ts";
import {
  INSTALL_HOOK_TIMEOUT_CONFIG_KEY,
  INSTALL_TOOL_PROFILE_CONFIG_KEY,
  resolveInstallHookTimeoutSeconds,
  resolveInstallToolProfile,
} from "../../../../src/core/install/settings.ts";
import { CONFIG_ORIGIN } from "../../../../src/core/validate.ts";
import { TOOL_SURFACE_PROFILES } from "../../../../src/mcp/profiles.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-install-block-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-install-block-cfg-"));
  configPath = join(configHome, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Write a whole `_brain.yaml`; `null` leaves the vault without one. */
function writeVaultConfig(body: string | null): void {
  if (body === null) return;
  atomicWriteFileSync(brainConfigPath(vault), body);
}

function writeUserConfig(body: string): void {
  atomicWriteFileSync(configPath, body);
}

function source() {
  return { vault, configPath };
}

function parse(body: string) {
  return validateBrainConfig(parseBrainYaml(body), "<install-block-test>");
}

describe("install: block parsing", () => {
  test("parses both keys", () => {
    const config = parse(
      'schema_version: 1\ninstall:\n  hook_timeout_seconds: 45\n  tool_profile: "recall"\n',
    );
    expect(config.install).toEqual({ hook_timeout_seconds: 45, tool_profile: "recall" });
  });

  test("an absent block leaves install undefined", () => {
    expect(parse("schema_version: 1\n").install).toBeUndefined();
  });

  test("rejects a non-positive hook_timeout_seconds by name", () => {
    expect(() => parse("schema_version: 1\ninstall:\n  hook_timeout_seconds: 0\n")).toThrow(
      /install\.hook_timeout_seconds/,
    );
  });

  test("rejects a non-integer hook_timeout_seconds by name", () => {
    expect(() => parse("schema_version: 1\ninstall:\n  hook_timeout_seconds: 2.5\n")).toThrow(
      /install\.hook_timeout_seconds/,
    );
  });

  test("rejects a hook_timeout_seconds past the ceiling by name", () => {
    expect(() =>
      parse(
        `schema_version: 1\ninstall:\n  hook_timeout_seconds: ${INSTALL_HOOK_TIMEOUT_SECONDS_MAX + 1}\n`,
      ),
    ).toThrow(/install\.hook_timeout_seconds/);
  });

  test("rejects an unknown tool_profile by name, listing the known ones", () => {
    let message = "";
    try {
      parse('schema_version: 1\ninstall:\n  tool_profile: "nope"\n');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("install.tool_profile");
    for (const name of INSTALL_TOOL_PROFILE_NAMES) expect(message).toContain(name);
  });

  test("the accepted names are exactly the tool-surface profile table's keys", () => {
    expect([...INSTALL_TOOL_PROFILE_NAMES].toSorted()).toEqual(
      Object.keys(TOOL_SURFACE_PROFILES).toSorted(),
    );
  });
});

describe("install setting resolution - three layers, highest first", () => {
  test("the committed vault block beats the user-level key", () => {
    writeVaultConfig("schema_version: 1\ninstall:\n  hook_timeout_seconds: 30\n");
    writeUserConfig(`${INSTALL_HOOK_TIMEOUT_CONFIG_KEY}: 20\n`);
    expect(resolveInstallHookTimeoutSeconds(source())).toEqual({
      value: 30,
      origin: CONFIG_ORIGIN.vaultConfig,
    });
  });

  test("the user-level key wins when the vault block does not set the key", () => {
    writeVaultConfig('schema_version: 1\ninstall:\n  tool_profile: "recall"\n');
    writeUserConfig(`${INSTALL_HOOK_TIMEOUT_CONFIG_KEY}: 20\n`);
    expect(resolveInstallHookTimeoutSeconds(source())).toEqual({
      value: 20,
      origin: CONFIG_ORIGIN.userConfig,
    });
  });

  test("an absent vault config and an absent user key yield the compiled default", () => {
    expect(resolveInstallHookTimeoutSeconds(source())).toEqual({
      value: BRAIN_INSTALL_DEFAULTS.hook_timeout_seconds,
      origin: CONFIG_ORIGIN.default,
    });
  });

  test("the same three layers decide the tool profile", () => {
    // The bottom tier is per HOST - the target's own `RUNTIME_FACTS`
    // row, not one compiled name - because a profile that fits a host
    // capping a workspace at forty tools is not the profile that fits a
    // host with no published limit. `kiro` declares none, so the bottom
    // tier selects no profile at all; `tests/core/install/
    // tool-ceiling.test.ts` drives the row-bearing side.
    expect(resolveInstallToolProfile(source(), "kiro")).toEqual({
      value: null,
      origin: CONFIG_ORIGIN.default,
    });

    writeUserConfig(`${INSTALL_TOOL_PROFILE_CONFIG_KEY}: minimal\n`);
    expect(resolveInstallToolProfile(source(), "kiro")).toEqual({
      value: "minimal",
      origin: CONFIG_ORIGIN.userConfig,
    });

    writeVaultConfig('schema_version: 1\ninstall:\n  tool_profile: "recall"\n');
    expect(resolveInstallToolProfile(source(), "kiro")).toEqual({
      value: "recall",
      origin: CONFIG_ORIGIN.vaultConfig,
    });
  });

  test("a user-config value that is not a known profile is refused by name", () => {
    writeUserConfig(`${INSTALL_TOOL_PROFILE_CONFIG_KEY}: nope\n`);
    expect(() => resolveInstallToolProfile(source(), "kiro")).toThrow(
      new RegExp(INSTALL_TOOL_PROFILE_CONFIG_KEY),
    );
  });

  test("a user-config hook timeout that is not a positive integer is refused by name", () => {
    writeUserConfig(`${INSTALL_HOOK_TIMEOUT_CONFIG_KEY}: abc\n`);
    expect(() => resolveInstallHookTimeoutSeconds(source())).toThrow(
      new RegExp(INSTALL_HOOK_TIMEOUT_CONFIG_KEY),
    );
  });
});

describe("an unreadable vault config refuses rather than defaulting", () => {
  const UNREADABLE = "schema_version: 1\ninstall:\n  hook_timeout_seconds: [broken\n";

  test("the hook-timeout resolver names the parse failure and the file", () => {
    writeVaultConfig(UNREADABLE);
    let message = "";
    try {
      resolveInstallHookTimeoutSeconds(source());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(brainConfigPath(vault));
    expect(message.length).toBeGreaterThan(brainConfigPath(vault).length);
  });

  test("the tool-profile resolver refuses on the same file", () => {
    writeVaultConfig(UNREADABLE);
    expect(() => resolveInstallToolProfile(source(), "kiro")).toThrow();
  });

  test("the refusal is not silently replaced by the default", () => {
    writeVaultConfig(UNREADABLE);
    writeUserConfig(`${INSTALL_HOOK_TIMEOUT_CONFIG_KEY}: 20\n`);
    expect(() => resolveInstallHookTimeoutSeconds(source())).toThrow();
  });

  test("a block that does not validate refuses too", () => {
    writeVaultConfig("schema_version: 1\ninstall:\n  hook_timeout_seconds: 0\n");
    expect(() => resolveInstallHookTimeoutSeconds(source())).toThrow(
      /install\.hook_timeout_seconds/,
    );
  });
});
