/**
 * MCP tokens on a switched machine (task 2.10, design D14 item 15): a
 * token minted there authenticates over HTTP, and the token audit lands
 * in the store (the machine has a device id and a store), not under the
 * vault's `Brain/`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { mintAgentToken, revokeAgentToken } from "../../src/core/brain/secrets/token-store.ts";
import { tokenStorePath } from "../../src/core/brain/secrets/store.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { authenticateRequest } from "../../src/mcp/http.ts";
import { deviceTokenStorePath, resolveMcpToken } from "../../src/mcp/token-source.ts";
import type { IncomingMessage } from "node:http";
import { SECRET_CUSTODY_AUDIT_DIR } from "../../src/core/brain/audit-dirs.ts";
import { switchDevice } from "../core/brain/fixtures/memory-twins.ts";
import { ledgerRows } from "../core/brain/store-only/fixtures.ts";
import { digestVaultTree } from "../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function request(key: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${key}` } } as unknown as IncomingMessage;
}

describe("MCP tokens once switched", () => {
  test("minting writes its custody audit to the store and no byte under Brain/", () => {
    env = makeStoreEnv("osb-wp2b-token-audit-", { dualWrite: false });
    switchDevice(env);
    const brain = join(env.vault, "Brain");
    const before = digestVaultTree(brain);
    mintAgentToken(env.vault, "mcp_token_edge", "edge-agent");
    expect(digestVaultTree(brain)).toBe(before);
    const rows = [
      ...ledgerRows(env.storeRoot, "shared", "reliability-audit"),
      ...ledgerRows(env.storeRoot, "private", "reliability-audit"),
    ] as Array<{ audit_dir: string; record: Record<string, unknown> }>;
    expect(rows.map((r) => [r.audit_dir, r.record["action"], r.record["target"]])).toEqual([
      [SECRET_CUSTODY_AUDIT_DIR, "mcp_token_minted", "mcp_token_edge"],
    ]);
  });

  test("writers and the server agree on the token map of an explicit config", () => {
    env = makeStoreEnv("osb-token-explicit-config-", { dualWrite: false });
    switchDevice(env);
    // The server and the token verbs run with a config other than the
    // process's default one, in its own folder.
    const explicit = join(env.parent, "explicit", "config.yaml");
    mkdirSync(dirname(explicit), { recursive: true });
    writeFileSync(explicit, readFileSync(env.configPath, "utf8"));
    const context = { vault: env.vault, configPath: explicit };
    const { tokenMaterial } = mintAgentToken(env.vault, "mcp_token_edge", "edge-agent", explicit);
    expect(resolveMcpToken(context, tokenMaterial)).toEqual({
      agent: "edge-agent",
      name: "mcp_token_edge",
    });
    expect(revokeAgentToken(env.vault, "mcp_token_edge", explicit)).toBe(true);
    expect(resolveMcpToken(context, tokenMaterial)).toBeNull();
  });

  test("a token minted on a switched machine authenticates", () => {
    env = makeStoreEnv("osb-wp2b-token-", { dualWrite: false });
    switchDevice(env);
    const { tokenMaterial } = mintAgentToken(env.vault, "mcp_token_edge", "edge-agent");
    const context = { vault: env.vault, configPath: env.configPath };
    const identity = authenticateRequest(request(tokenMaterial), {
      apiKey: null,
      resolveToken: (candidate) => resolveMcpToken(context, candidate),
    });
    expect(identity).toEqual({ agent: "edge-agent", via: "token" });
    expect(
      authenticateRequest(request("not-a-token"), {
        apiKey: null,
        resolveToken: (candidate) => resolveMcpToken(context, candidate),
      }),
    ).toBeNull();
  });

  test("a revocation lands on a switched machine, whatever the per-vault file holds", () => {
    env = makeStoreEnv("osb-wp2b-token-", { dualWrite: false });
    switchDevice(env);
    const { tokenMaterial } = mintAgentToken(env.vault, "mcp_token_edge", "edge-agent");
    const context = { vault: env.vault, configPath: env.configPath };
    // Once switched the writers write the device-config copy, and the server reads it.
    expect(existsSync(deviceTokenStorePath(env.configPath))).toBe(true);
    expect(resolveMcpToken(context, tokenMaterial)).toMatchObject({ agent: "edge-agent" });
    // A stale per-vault map that still lists the token does not revive it.
    mkdirSync(dirname(tokenStorePath(env.vault)), { recursive: true });
    writeFileSync(tokenStorePath(env.vault), readFileSync(deviceTokenStorePath(env.configPath)));
    expect(revokeAgentToken(env.vault, "mcp_token_edge")).toBe(true);
    expect(resolveMcpToken(context, tokenMaterial)).toBeNull();
    // A token minted after the revocation authenticates.
    const { tokenMaterial: fresh } = mintAgentToken(env.vault, "mcp_token_new", "new-agent");
    expect(resolveMcpToken(context, fresh)).toMatchObject({ agent: "new-agent" });
  });
});
