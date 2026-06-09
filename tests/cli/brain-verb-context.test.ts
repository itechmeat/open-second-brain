/**
 * Unit tests for the shared Brain verb context helpers. Every verb
 * under src/cli/brain/verbs/ resolves its (config, vault) pair and
 * acting agent through these instead of repeating the resolution
 * boilerplate per file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../../src/cli/argparse.ts";
import { brainVerbContext, resolveBrainAgent } from "../../src/cli/brain/helpers.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let configHome: string;
let savedConfigEnv: string | undefined;
let vaultDir: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "o2b-verbctx-cfg-"));
  vaultDir = mkdtempSync(join(tmpdir(), "o2b-verbctx-vault-"));
  savedConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vaultDir}\nagent_name: config-agent\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  if (savedConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfigEnv;
  rmSync(configHome, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("brainVerbContext", () => {
  test("an explicit --vault flag wins over the configured vault", () => {
    const ctx = brainVerbContext({ vault: "/explicit/vault" });
    expect(ctx.vault).toBe("/explicit/vault");
  });

  test("falls back to the configured vault when no flag is given", () => {
    const ctx = brainVerbContext({});
    expect(ctx.vault).toBe(vaultDir);
    expect(typeof ctx.config).toBe("string");
  });

  test("rejects an explicitly empty --vault flag with a CliError", () => {
    expect(() => brainVerbContext({ vault: "   " })).toThrow(CliError);
  });
});

describe("resolveBrainAgent", () => {
  test("an explicit --agent flag wins over the configured agent", () => {
    const ctx = brainVerbContext({});
    expect(resolveBrainAgent({ agent: "flag-agent" }, ctx.config)).toBe("flag-agent");
  });

  test("falls back to the configured agent name", () => {
    const ctx = brainVerbContext({});
    expect(resolveBrainAgent({}, ctx.config)).toBe("config-agent");
  });
});
