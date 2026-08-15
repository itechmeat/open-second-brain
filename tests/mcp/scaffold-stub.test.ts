/**
 * MCP surface for materialising an unresolved wikilink target (B3):
 * `brain_scaffold_stub`.
 *
 * The defect this covers is the surface's: the doctor could TELL an agent
 * that `[[Foo]]` is referenced by four notes and exists nowhere, and the
 * agent had no verb to do anything about it. This file exercises the
 * tool's own responsibilities - the two actions, the refusal that a
 * partially-resolved index produces instead of an empty list, and the
 * typed refusal codes the core raises reaching the caller as data rather
 * than as prose.
 *
 * Deliberately NOT covered here: the stub's contents and the resolver's
 * fail-closed behaviour (the core test owns those), and the SQL (the
 * search test owns that).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { DANGLING_SCAN } from "../../src/core/brain/notes/scaffold-stub.ts";
import { LIFECYCLE_FILE_TOOLS } from "../../src/mcp/brain/lifecycle-file-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scaffold-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scaffold-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool: ToolDefinition = LIFECYCLE_FILE_TOOLS.find((t) => t.name === "brain_scaffold_stub")!;

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool.handler(ctx, args)) as Record<string, unknown>;
}

function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("registration", () => {
  test("advertises a closed action enum and requires only the action", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["action"]);
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties["action"]?.enum).toEqual(["list", "write"]);
  });
});

describe("list", () => {
  test("reports the index refusal instead of an empty list", async () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const res = await call({ action: "list" });
    // No index has ever been built here. "no dangling links" would be a
    // clean bill of health for a vault nobody measured.
    expect(res["state"]).toBe(DANGLING_SCAN.indexMissing);
    expect(res["targets"]).toEqual([]);
    expect(res["detail"]).not.toBeNull();
    expect(typeof res["next_command"]).toBe("string");
  });
});

describe("write", () => {
  test("dry run is the default and materialises nothing", async () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const res = await call({ action: "write", target: "Projects/Ghost" });
    expect(res["applied"]).toBe(false);
    expect(res["path"]).toBe("Projects/Ghost.md");
    expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(false);
  });

  test("materialises the stub under an explicit apply", async () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const res = await call({
      action: "write",
      target: "Projects/Ghost",
      sources: ["Projects/A.md"],
      apply: true,
    });
    expect(res["outcome"]).toBe("created");
    expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(true);
  });

  test("a target that already resolves is a structured refusal", async () => {
    note("Projects/Real.md", "x\n");
    let caught: unknown;
    try {
      await call({ action: "write", target: "Projects/Real", apply: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).data).toMatchObject({ code: "target_resolves" });
  });

  test("write without a target is refused rather than defaulted", async () => {
    await expect(call({ action: "write", apply: true })).rejects.toBeInstanceOf(MCPError);
  });

  test("an unknown action is refused rather than falling back to one that exists", async () => {
    await expect(call({ action: "invent" })).rejects.toBeInstanceOf(MCPError);
  });
});
