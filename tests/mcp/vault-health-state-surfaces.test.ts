/**
 * `vault_health` carries the in-vault state inventory.
 *
 * The doctor answers "is this vault healthy". It could not answer "and
 * where does it keep its state", which is the question an agent has to
 * settle before it proposes moving or deleting anything. The field is the
 * SAME value `o2b state status` prints - one record, two renderings - so
 * this file asserts the identity rather than the content: a second
 * hand-assembled copy would pass a "both are present" check and drift on
 * the next row added.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCPServer } from "../../src/mcp/index.ts";
import {
  inventoryStateSurfaces,
  STATE_SURFACES,
  type StateInventory,
} from "../../src/core/state/surfaces.ts";
import { createSandboxVault } from "../helpers/fixtures.ts";
import { PARTNER_CODEGRAPH_DISABLED_ENV } from "../../src/core/config.ts";

async function health(vault: string): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault });
  const r = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "vault_health", arguments: {} },
  })) as { result: { structuredContent: Record<string, unknown> } };
  return r.result.structuredContent;
}

describe("vault_health state surfaces", () => {
  // The doctor consults the codegraph partner whenever that binary is on
  // PATH, which costs seconds per call and tells this file nothing.
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[PARTNER_CODEGRAPH_DISABLED_ENV];
    process.env[PARTNER_CODEGRAPH_DISABLED_ENV] = "true";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[PARTNER_CODEGRAPH_DISABLED_ENV];
    else process.env[PARTNER_CODEGRAPH_DISABLED_ENV] = saved;
  });

  test("the tool reports one row per declared surface", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-vault-health-state-"));
    try {
      const vault = createSandboxVault(tmp);
      const payload = await health(vault);
      const inventory = payload["state_surfaces"] as StateInventory;
      expect(inventory.vault).toBe(vault);
      expect(inventory.surfaces.length).toBe(STATE_SURFACES.length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the field is the inventory value itself, not a second copy of it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-vault-health-state-"));
    try {
      const vault = createSandboxVault(tmp);
      const payload = await health(vault);
      const direct = inventoryStateSurfaces({
        vault,
        env: process.env,
        config: {},
      });
      expect(payload["state_surfaces"]).toEqual(direct);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the existing health fields are untouched", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-vault-health-state-"));
    try {
      const vault = createSandboxVault(tmp);
      const payload = await health(vault);
      expect(Array.isArray(payload["checks"])).toBe(true);
      expect(Array.isArray(payload["notices"])).toBe(true);
      expect(payload["vault_path"]).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
