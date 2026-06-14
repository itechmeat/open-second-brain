/**
 * MCP integration test for `brain_create_note` (Brain Portability &
 * Interop suite, Unit D). The tool writes an actual vault note file
 * (path + frontmatter + content) - distinct from `brain_note`, which
 * only appends a log line. Handler exercised directly with a minimal
 * context. Refusals map to INVALID_PARAMS and write nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tools.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-create-note-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-create-note-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool = NOTES_TOOLS.find((t) => t.name === "brain_create_note")!;
const handler = tool.handler;

describe("brain_create_note", () => {
  test("is registered with a write-shaped name and schema", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("path");
  });

  test("creates a note file with frontmatter and content, returns its path", async () => {
    const res = await handler(ctx, {
      path: "Notes/FromAgent.md",
      frontmatter: { title: "From Agent", tags: ["x"] },
      content: "Captured by an agent.",
    });
    expect(res).toMatchObject({ created: true, path: "Notes/FromAgent.md" });
    const md = readFileSync(join(vault, "Notes/FromAgent.md"), "utf8");
    expect(md).toContain("title: From Agent");
    expect(md).toContain("Captured by an agent.");
  });

  test("path traversal is rejected with INVALID_PARAMS and writes nothing", async () => {
    await expect(handler(ctx, { path: "../escape.md", content: "x" })).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });

  test("writing into the Brain root is rejected with INVALID_PARAMS", async () => {
    await expect(handler(ctx, { path: "Brain/x.md", content: "x" })).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "Brain/x.md"))).toBe(false);
  });

  test("a non-object frontmatter is rejected with INVALID_PARAMS", async () => {
    await expect(
      handler(ctx, { path: "Notes/Bad.md", frontmatter: "not-an-object", content: "x" }),
    ).rejects.toThrow(MCPError);
  });

  test("a prototype-mutating frontmatter key is rejected, never assigned", async () => {
    // JSON.parse creates an OWN "__proto__" key (the real JSON-RPC vector),
    // unlike an object literal where __proto__ sets the prototype.
    const frontmatter = JSON.parse('{"__proto__": ["polluted"]}');
    await expect(
      handler(ctx, { path: "Notes/Proto.md", frontmatter, content: "x" }),
    ).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "Notes/Proto.md"))).toBe(false);
  });

  test("clobbering an existing note is rejected", async () => {
    await handler(ctx, { path: "Notes/Once.md", content: "first" });
    await expect(handler(ctx, { path: "Notes/Once.md", content: "second" })).rejects.toThrow(
      MCPError,
    );
    expect(readFileSync(join(vault, "Notes/Once.md"), "utf8")).toContain("first");
  });
});
