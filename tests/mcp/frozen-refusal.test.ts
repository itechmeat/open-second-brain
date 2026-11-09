/**
 * What an agent is told when the vault is frozen (who-wrote-what,
 * Task C).
 *
 * The guard that refuses the write sits below the log module and cannot
 * append an event without closing an import cycle, so the MCP dispatch -
 * the one seam that knows both the refusal and the caller - is where the
 * refusal becomes a structured error and a `write-refused` line. That
 * makes the freeze auditable from the agent's side, which is the side it
 * exists to hold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freezeVault, unfreezeVault } from "../../src/core/brain/freeze.ts";
import { resetFreezeMarkerCache } from "../../src/core/brain/freeze-marker.ts";
import { listLogDates, readLogDay } from "../../src/core/brain/log-jsonl.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { holdMigrationGate, releaseMigrationGate } from "../../src/core/migration-gate.ts";
import {
  MIGRATION_IN_PROGRESS_REFUSAL,
  VAULT_FROZEN_REFUSAL,
} from "../../src/mcp/frozen-refusal.ts";
import { MCPServer } from "../../src/mcp/server.ts";

let tmp: string;
let vault: string;
let server: MCPServer;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-frozen-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  server = new MCPServer({ vault });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

async function createNote(path: string) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "brain_create_note", arguments: { path, content: "body" } },
  });
}

/** `brain_status`'s structured payload. */
async function status(): Promise<Record<string, unknown>> {
  const result = await server.callTool("brain_status", {});
  return result["structuredContent"] as Record<string, unknown>;
}

/** Every `write-refused` payload in the log, across every day and shard. */
function refusals(): ReadonlyArray<Record<string, unknown>> {
  const out: Record<string, unknown>[] = [];
  for (const date of listLogDates(vault)) {
    for (const entry of readLogDay(vault, date).entries) {
      if (entry.eventType === "write-refused") out.push(entry.body);
    }
  }
  return out;
}

describe("a write tool called on a frozen vault", () => {
  test("comes back as a structured refusal naming the freeze and the way out", async () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    const response = await createNote("notes/frozen.md");
    const error = (response as { error?: { message: string; data?: unknown } }).error;
    expect(error).toBeDefined();
    const data = error!.data as Record<string, unknown>;
    expect(data["code"]).toBe(VAULT_FROZEN_REFUSAL);
    expect(data["by"]).toBe("@operator");
    expect(data["reason"]).toBe("migrating");
    expect(typeof data["frozen_at"]).toBe("string");
    expect(data["next_command"]).toBe("o2b brain unfreeze");
    expect(data["tool"]).toBe("brain_create_note");
    expect(error!.message).toContain("o2b brain unfreeze");
    // The refusal has to be a refusal: nothing may have landed.
    expect(existsSync(join(vault, "notes", "frozen.md"))).toBe(false);
  });

  test("appends exactly one write-refused event naming the tool and the caller", async () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    await createNote("notes/frozen.md");
    const recorded = refusals();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!["tool"]).toBe("brain_create_note");
    expect(recorded[0]!["reason"]).toBe("migrating");
    expect(typeof recorded[0]!["agent"]).toBe("string");
  });

  test("records one event per refused call, so a retry loop is visible", async () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    await createNote("notes/a.md");
    await createNote("notes/b.md");
    expect(refusals()).toHaveLength(2);
  });

  test("goes back to writing once the freeze is lifted", async () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    await createNote("notes/frozen.md");
    unfreezeVault(vault, { agent: "@operator" });

    const response = await createNote("notes/thawed.md");
    expect((response as { error?: unknown }).error).toBeUndefined();
    expect(existsSync(join(vault, "notes", "thawed.md"))).toBe(true);
  });
});

describe("a write tool called while a store migration of the vault runs here", () => {
  test("comes back as the same structured refusal, naming the migration and the way out", async () => {
    // Restored in `finally`, not deleted: the preload points the state root
    // at a temp dir, and deleting it sends every later test in this process
    // to the developer's real `~/.local/state`.
    const saved = {
      XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
      LOCALAPPDATA: process.env["LOCALAPPDATA"],
    };
    process.env["XDG_STATE_HOME"] = join(tmp, "state");
    process.env["LOCALAPPDATA"] = join(tmp, "state");
    try {
      holdMigrationGate(vault, "migrate-test");
      const response = await createNote("notes/gated.md");
      const error = (response as { error?: { message: string; data?: unknown } }).error;
      const data = error!.data as Record<string, unknown>;
      expect(data["code"]).toBe(MIGRATION_IN_PROGRESS_REFUSAL);
      expect(data["run_id"]).toBe("migrate-test");
      expect(data["tool"]).toBe("brain_create_note");
      expect(data["next_command"]).toBe("o2b brain migrate-store --resume");
      // The way out is named once in the prose, not twice.
      expect(error!.message.split("--resume")).toHaveLength(2);
      expect(existsSync(join(vault, "notes", "gated.md"))).toBe(false);
      releaseMigrationGate(vault, "migrate-test");
      expect((await createNote("notes/open.md")) as { error?: unknown }).not.toHaveProperty(
        "error",
      );
    } finally {
      releaseMigrationGate(vault, "migrate-test");
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("brain_status", () => {
  test("reports the freeze, and reports its absence just as plainly", async () => {
    const open = await status();
    expect(open["frozen"]).toBeNull();

    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    const marker = (await status())["frozen"] as Record<string, unknown>;
    expect(marker["by"]).toBe("@operator");
    expect(marker["reason"]).toBe("migrating");
    expect(typeof marker["frozen_at"]).toBe("string");
    expect(typeof marker["device_id"]).toBe("string");
  });
});

describe("an open vault", () => {
  test("records no refusal at all", async () => {
    const response = await createNote("notes/open.md");
    expect((response as { error?: unknown }).error).toBeUndefined();
    expect(refusals()).toHaveLength(0);
  });
});
