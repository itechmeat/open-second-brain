/**
 * The CLI with no vault configured (task 2.10, design D14): `o2b status`
 * and the MCP server start and answer, the tool-call bridge answers
 * `second_brain_status`, each with the store block of a machine with no
 * store, and a verb that needs a vault refuses. The verb-named refusals of
 * the brain verbs are owned by `no-vault-memory.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainVerbContext } from "../../src/cli/brain/helpers.ts";
import { CliError } from "../../src/cli/argparse.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let configPath: string;
let saved: string | undefined;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-no-vault-cli-"));
  configPath = join(parent, "config.yaml");
  writeFileSync(configPath, "agent_name: tester\n");
  saved = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved;
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function env(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
  };
}

/**
 * The store block of a machine with no vault and no store: answered (not
 * an error), and saying exactly that.
 */
function expectNoStoreBlock(store: unknown): void {
  expect(store).toMatchObject({
    initialized: false,
    store_id: null,
    error: null,
    device_id: "test-device",
    partitions_held: [],
    migration: { available: false, store_exists: false, legacy_tree_present: false },
  });
}

describe("with no vault configured", () => {
  test("o2b status answers with the store block", async () => {
    const r = await runCli(["status", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expectNoStoreBlock(out["store"]);
  });

  test("the MCP server starts on stdio and answers second_brain_status", async () => {
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "second_brain_status", arguments: {} },
    });
    const r = await runCli(["mcp"], { stdin: `${init}\n${call}\n`, env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stderr).toContain("vault=none");
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
    const status = lines.find((line) => line.id === 2)!.result!["structuredContent"] as Record<
      string,
      unknown
    >;
    expect(status["vault_exists"]).toBe(false);
    expectNoStoreBlock(status["store"]);
  });

  test("the tool-call bridge answers second_brain_status", async () => {
    const r = await runCli(["tool-call", "second_brain_status"], { env: env() });
    expect(r.returncode).toBe(0);
    const result = JSON.parse(r.stdout) as { content: Array<{ text: string }> };
    const status = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(status["vault_exists"]).toBe(false);
    expectNoStoreBlock(status["store"]);
  });

  test("an explicitly empty --vault stays a user error", () => {
    expect(() => brainVerbContext({ vault: "" }, { vault: "optional" })).toThrow(CliError);
  });

  // `onboarding` works with no vault since the no-vault checklist (WP5);
  // `brain lint` reads vault pages and still refuses, through the generic
  // no-vault error rather than a verb-named one.
  test("a verb that needs a vault still refuses as before", async () => {
    const r = await runCli(["brain", "lint"], { env: env() });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("no vault configured");
  });
});
