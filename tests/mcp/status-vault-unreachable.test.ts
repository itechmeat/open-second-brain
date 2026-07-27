/**
 * `second_brain_status` on a vault directory it cannot examine.
 *
 * The last instance of the conflation this wave has been closing. The
 * probe behind `vault_exists` answered `false` for a vault that is not
 * there AND for one behind a directory without the execute bit, so the
 * most misleading sentence this tool can produce - "this install has no
 * vault" - was what an operator got for a permission fault. Three blocks
 * hang off that answer (`brain`, `search`, `vault`), and each was SKIPPED
 * on the false branch, so the payload also said the Brain layer is not
 * there, search is off, and no exclusion policy applies - four unknowns
 * rendered as four confident negatives.
 *
 * The field degrades the way the config fields do: `{ error }`, never an
 * omission and never a bare `false`. The blocks follow the search-block
 * precedent - built and degraded rather than skipped, since a missing
 * block reads as the very "off" the gate could not determine.
 *
 * The two answerable cases are pinned here too, because a degradation
 * that changes them has traded one breakage for another.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";

let tmp: string;
/** Parent whose execute bit is dropped, hiding the vault beneath it. */
let sealed: string;
let sealedVault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-status-unreachable-"));
  sealed = join(tmp, "sealed");
  sealedVault = join(sealed, "vault");
  mkdirSync(join(sealedVault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `api_key: "secret"\n`, "utf8");
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
  chmodSync(sealed, 0o700);
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function status(vault: string): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "tools/call",
    params: { name: "second_brain_status", arguments: {} },
  })) as { result?: { structuredContent: Record<string, unknown>; isError?: boolean } };
  return r.result!.structuredContent;
}

async function queryError(vault: string): Promise<string> {
  const server = new MCPServer({ vault, configPath });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "tools/call",
    params: { name: "second_brain_query", arguments: {} },
  })) as {
    result?: { content: ReadonlyArray<{ text: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (r.error) return r.error.message;
  return r.result!.content[0]!.text;
}

describe("the two answerable cases keep their exact answers", () => {
  test("a readable vault still reports the literal boolean true", async () => {
    const vault = join(tmp, "plain-vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const payload = await status(vault);
    expect(payload["vault_exists"]).toBe(true);
    expect(typeof payload["vault_exists"]).toBe("boolean");
    // The blocks the answer gates stay exactly as they were.
    expect(payload).toHaveProperty("brain");
    expect(payload).toHaveProperty("vault");
  });

  test("a genuinely absent vault still reports the literal boolean false and omits the blocks", async () => {
    const payload = await status(join(tmp, "never-created"));
    expect(payload["vault_exists"]).toBe(false);
    expect(typeof payload["vault_exists"]).toBe("boolean");
    expect(payload["brain"]).toBeUndefined();
    expect(payload["search"]).toBeUndefined();
    expect(payload["vault"]).toBeUndefined();
  });
});

describe("a vault that cannot be examined is not a vault that is absent", () => {
  test("vault_exists carries the reason instead of collapsing to false", async () => {
    chmodSync(sealed, 0o000);
    const payload = await status(sealedVault);
    expect(payload["vault_exists"]).not.toBe(false);
    const field = payload["vault_exists"] as Record<string, unknown>;
    expect(typeof field["error"]).toBe("string");
    expect(String(field["error"])).toContain(sealedVault);
  });

  test("the three gated blocks are built and degraded, never skipped", async () => {
    chmodSync(sealed, 0o000);
    const payload = await status(sealedVault);
    for (const key of ["brain", "search", "vault"]) {
      expect(payload).toHaveProperty(key);
      const block = payload[key] as Record<string, unknown>;
      expect(typeof block["error"]).toBe("string");
      expect(String(block["error"])).toContain(sealedVault);
    }
  });

  test("the config blocks still answer, since the config is fine", async () => {
    chmodSync(sealed, 0o000);
    const payload = await status(sealedVault);
    expect(payload["config_path"]).toBe(configPath);
    expect(payload["config_exists"]).toBe(true);
    expect(payload["config_keys"]).toEqual(["api_key"]);
  });
});

describe("second_brain_query separates the same two conditions", () => {
  test("an absent vault keeps its existing refusal", async () => {
    const message = await queryError(join(tmp, "never-created"));
    expect(message).toContain("vault directory missing");
  });

  test("an unexaminable vault is refused as unexaminable, not as missing", async () => {
    chmodSync(sealed, 0o000);
    const message = await queryError(sealedVault);
    expect(message).not.toContain("vault directory missing");
    expect(message).toContain(sealedVault);
  });
});
