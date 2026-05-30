import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tempDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "o2b-cli-json-"));
  vault = join(tempDir, "vault");
  configPath = join(tempDir, "config.yaml");
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: "",
    VAULT_AGENT_NAME: "",
  };
}

describe("inherited CLI --json contract", () => {
  test("text-only commands accept --json and return a fallback envelope", async () => {
    const result = await runCli(["doctor", "--vault", vault, "--json"], {
      env: env(),
    });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.command).toBe("doctor");
    expect(parsed.code).toBe(result.returncode);
    expect(typeof parsed.ok).toBe("boolean");
    expect(typeof parsed.stdout).toBe("string");
    expect(parsed.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  test("commands with semantic JSON keep their existing payload shape", async () => {
    const result = await runCli(["status", "--config", configPath, "--json"], {
      env: env(),
    });

    expect(result.returncode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.config_path).toBe(configPath);
    expect(parsed).not.toHaveProperty("command");
    expect(parsed).not.toHaveProperty("stdout");
  });

  test("fallback JSON redacts secret-shaped output", async () => {
    const result = await runCli(
      [
        "init",
        "--vault",
        vault,
        "--agent-name",
        "api_key=super-secret-value",
        "--json",
      ],
      { env: env() },
    );

    expect(result.returncode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });
});
