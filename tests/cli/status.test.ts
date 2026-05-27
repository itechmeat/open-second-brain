/**
 * Tests for `o2b status` semantic-search hint (v0.10.10).
 *
 * Drives §8 of `docs/plans/2026-05-20-v0.10.10-design.md` — the
 * single-line hint that surfaces when semantic search is enabled in
 * config but cannot run (key missing, etc.), plus the equivalent
 * `--json` keys.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let cfgDir: string;
let cfgPath: string;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "o2b-status-semantic-"));
  cfgPath = join(cfgDir, "config.yaml");
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

const ENV_CLEAN: Record<string, string> = {
  OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "",
  OPEN_SECOND_BRAIN_EMBEDDING_KEY: "",
  OPEN_SECOND_BRAIN_CONFIG: "",
  VAULT_AGENT_NAME: "",
  VAULT_DIR: "",
};

function writeCfg(body: string): void {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgPath, body, "utf8");
}

describe("o2b status — semantic hint (human output)", () => {
  test("hint absent when semantic_enabled is true and key is present", async () => {
    writeCfg(
      [
        "vault: /tmp/x",
        'search_semantic_enabled: "true"',
        'embedding_api_key: "sk-test"',
        'embedding_base_url: "https://example.test/v1"',
        'embedding_model: "test-model"',
      ].join("\n") + "\n",
    );
    const r = await runCli(["status", "--config", cfgPath], { env: ENV_CLEAN });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("semantic: off");
  });

  test("hint present when semantic_enabled is false", async () => {
    writeCfg("vault: /tmp/x\n");
    const r = await runCli(["status", "--config", cfgPath], { env: ENV_CLEAN });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("semantic: off");
    expect(r.stdout).toContain("o2b search check");
  });

  test("hint present when key is missing even with enabled flag set", async () => {
    writeCfg('vault: /tmp/x\nsearch_semantic_enabled: "true"\n');
    const r = await runCli(["status", "--config", cfgPath], { env: ENV_CLEAN });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("semantic: off");
  });

  test("hint present when configured key is whitespace-only", async () => {
    writeCfg(
      ["vault: /tmp/x", 'search_semantic_enabled: "true"', 'embedding_api_key: "   "'].join("\n") +
        "\n",
    );
    const r = await runCli(["status", "--config", cfgPath], { env: ENV_CLEAN });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("semantic: off");
  });

  test("hint suppressed when search is disabled outright", async () => {
    writeCfg('vault: /tmp/x\nsearch_enabled: "false"\n');
    const r = await runCli(["status", "--config", cfgPath], { env: ENV_CLEAN });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("semantic:");
  });
});

describe("o2b status — semantic fields (--json)", () => {
  test("--json carries semantic flags and hint when semantic is off", async () => {
    writeCfg("vault: /tmp/x\n");
    const r = await runCli(["status", "--config", cfgPath, "--json"], {
      env: ENV_CLEAN,
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.semantic_enabled).toBe(false);
    expect(parsed.embedding_key_present).toBe(false);
    expect(typeof parsed.semantic_hint).toBe("string");
    expect(parsed.semantic_hint).toContain("o2b search check");
  });

  test("--json semantic_hint is null when fully configured", async () => {
    writeCfg(
      ["vault: /tmp/x", 'search_semantic_enabled: "true"', 'embedding_api_key: "sk-test"'].join(
        "\n",
      ) + "\n",
    );
    const r = await runCli(["status", "--config", cfgPath, "--json"], {
      env: ENV_CLEAN,
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.semantic_enabled).toBe(true);
    expect(parsed.embedding_key_present).toBe(true);
    expect(parsed.semantic_hint).toBeNull();
  });

  test("--json treats whitespace-only env key as missing", async () => {
    writeCfg('vault: /tmp/x\nsearch_semantic_enabled: "true"\n');
    const r = await runCli(["status", "--config", cfgPath, "--json"], {
      env: {
        ...ENV_CLEAN,
        OPEN_SECOND_BRAIN_EMBEDDING_KEY: "   ",
      },
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.embedding_key_present).toBe(false);
    expect(typeof parsed.semantic_hint).toBe("string");
  });

  test("--json semantic_hint is null when search is disabled outright", async () => {
    writeCfg('vault: /tmp/x\nsearch_enabled: "false"\n');
    const r = await runCli(["status", "--config", cfgPath, "--json"], {
      env: ENV_CLEAN,
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.semantic_hint).toBeNull();
  });
});
