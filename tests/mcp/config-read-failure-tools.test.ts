/**
 * The two diagnostic tool surfaces, on a plugin config that is present but
 * unreadable.
 *
 * Both tools exist to answer "what does this install see". Raising instead
 * of answering destroys the payload that names the condition:
 *
 *   - `vault_health` computes the whole report - `config_writeable` FAILs
 *     with a fix line, which IS the diagnosis - and then raised on the last
 *     field, `vault_path`, because the opaque store reference is keyed by a
 *     secret that lives in the config;
 *   - `second_brain_status` raised before producing `config_path`,
 *     `config_exists`, `config_keys` and `config`, which are precisely the
 *     fields whose purpose is to answer the question.
 *
 * The fix must not be a silent omission. An unresolvable field carries the
 * `{ error: "..." }` shape this payload already uses for the `vault` block
 * when the vault scope cannot be resolved, so the failure is a value a
 * consumer reads rather than a key it has to notice is missing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const VALID_CONFIG = `vault: "/srv/example-vault"\napi_key: "secret"\n`;

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-config-read-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, VALID_CONFIG, "utf8");
  for (const k of [
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  chmodSync(configPath, 0o600);
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * Invoke the tool handler with the config unreadable.
 *
 * Deliberately the handler and not `MCPServer.handleRequest`, so this file
 * pins what the two payloads SAY without also depending on how the request
 * path reaches them. That path is covered next door, in
 * `config-read-failure-server.test.ts`: the server used to resolve the
 * agent name eagerly and raise on the same broken config before any
 * handler ran, which made both payloads unobservable through `tools/call`.
 */
async function callTool(name: string): Promise<Record<string, unknown>> {
  const ctx: ServerContext = { vault, configPath, repoRoot: null };
  const tool = findTool(buildToolTable(), name);
  chmodSync(configPath, 0o000);
  try {
    return (await tool.handler(ctx, {})) as Record<string, unknown>;
  } finally {
    chmodSync(configPath, 0o600);
  }
}

describe("vault_health reports the broken config instead of throwing on it", () => {
  test("the report still names the failing check and its fix", async () => {
    const payload = await callTool("vault_health");
    const checks = payload["checks"] as Array<Record<string, unknown>>;
    const configCheck = checks.find((c) => c["name"] === "config_writeable");
    expect(configCheck).toBeDefined();
    expect(configCheck!["ok"]).toBe(false);
    expect(String(configCheck!["message"])).toContain(configPath);
    expect(payload["ok"]).toBe(false);
  });

  test("vault_path carries the error rather than omitting itself", async () => {
    const payload = await callTool("vault_health");
    expect(payload).toHaveProperty("vault_path");
    const vaultPath = payload["vault_path"] as Record<string, unknown>;
    expect(String(vaultPath["error"])).toContain(configPath);
    // The redaction contract holds even in the degraded shape: an
    // unresolvable reference must not fall back to the raw host path.
    expect(JSON.stringify(payload["vault_path"])).not.toContain(vault);
  });
});

describe("second_brain_status reports the broken config instead of throwing on it", () => {
  test("the config fields answer the question they exist to answer", async () => {
    const payload = await callTool("second_brain_status");
    expect(payload["config_path"]).toBe(configPath);
    // Present, not absent: `false` here is the collapse the read split
    // removed, and it would read as "this install was never configured".
    expect(payload["config_exists"]).toBe(true);
    expect(String((payload["config"] as Record<string, unknown>)["error"])).toContain(configPath);
    expect(String((payload["config_keys"] as Record<string, unknown>)["error"])).toContain(
      configPath,
    );
  });

  test("the rest of the payload still arrives", async () => {
    const payload = await callTool("second_brain_status");
    expect(payload["vault_exists"]).toBe(true);
    expect(payload).toHaveProperty("brain");
    expect(payload).toHaveProperty("vault_path");
  });
});
