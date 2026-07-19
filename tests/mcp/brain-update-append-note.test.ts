/**
 * MCP integration tests for `brain_update_note` and `brain_append_note`
 * (W1, t_3ff3fe77). Both tools are single-operation batches over the
 * atomic write-batch core (kernel 2). They reuse the create-note safety
 * envelope and refuse a missing target with a typed error mapped to
 * INVALID_PARAMS.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { NOTES_TOOLS, writeBatchErrorToMcp } from "../../src/mcp/brain/notes-tools.ts";
import { WriteBatchError } from "../../src/core/brain/write-batch.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

/** Await `result`, assert it rejected with an MCPError, and return it. */
async function rejectedMcpError(result: unknown): Promise<MCPError> {
  let thrown: unknown;
  try {
    await result;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(MCPError);
  return thrown as MCPError;
}

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-update-note-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-update-note-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedNote(rel: string, body: string, frontmatter = ""): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const fm = frontmatter ? `---\n${frontmatter}\n---\n\n` : "";
  writeFileSync(abs, `${fm}${body}\n`, "utf8");
}

const updateTool = NOTES_TOOLS.find((t) => t.name === "brain_update_note")!;
const appendTool = NOTES_TOOLS.find((t) => t.name === "brain_append_note")!;

describe("brain_update_note", () => {
  test("is registered and requires a path", () => {
    expect(updateTool).toBeDefined();
    expect(updateTool.inputSchema.required).toContain("path");
  });

  test("merges frontmatter and replaces the body of an existing note", async () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc\nstatus: draft");
    const res = await updateTool.handler(ctx, {
      path: "Notes/Doc.md",
      frontmatter: { status: "final" },
      content: "new body",
    });
    expect(res).toMatchObject({ updated: true, path: "Notes/Doc.md" });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("title: Doc");
    expect(md).toContain("status: final");
    expect(md).toContain("new body");
    expect(md).not.toContain("old body");
  });

  test("a missing target is rejected with INVALID_PARAMS and writes nothing", async () => {
    const err = await rejectedMcpError(
      updateTool.handler(ctx, { path: "Notes/Ghost.md", content: "x" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "target_missing", index: 0, path: "Notes/Ghost.md" });
    expect(existsSync(join(vault, "Notes/Ghost.md"))).toBe(false);
  });

  test("requires at least frontmatter or content", async () => {
    seedNote("Notes/Doc.md", "body", "title: Doc");
    const err = await rejectedMcpError(updateTool.handler(ctx, { path: "Notes/Doc.md" }));
    expect(err.code).toBe(INVALID_PARAMS);
  });

  test("path traversal is refused with INVALID_PARAMS", async () => {
    const err = await rejectedMcpError(
      updateTool.handler(ctx, { path: "../escape.md", content: "x" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "invalid_path", index: 0 });
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });
});

describe("brain_append_note", () => {
  test("is registered and requires path and content", () => {
    expect(appendTool).toBeDefined();
    expect(appendTool.inputSchema.required).toContain("path");
    expect(appendTool.inputSchema.required).toContain("content");
  });

  test("appends to the body of an existing note", async () => {
    seedNote("Notes/Doc.md", "first", "title: Doc");
    const res = await appendTool.handler(ctx, { path: "Notes/Doc.md", content: "second" });
    expect(res).toMatchObject({ appended: true, path: "Notes/Doc.md" });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("first");
    expect(md).toContain("second");
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
  });

  test("a missing target is rejected with INVALID_PARAMS", async () => {
    const err = await rejectedMcpError(
      appendTool.handler(ctx, { path: "Notes/Ghost.md", content: "x" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "target_missing", index: 0, path: "Notes/Ghost.md" });
  });

  test("refuses to author into the Brain machinery root", async () => {
    const err = await rejectedMcpError(
      appendTool.handler(ctx, { path: "Brain/x.md", content: "y" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "excluded", index: 0 });
  });
});

describe("writeBatchErrorToMcp", () => {
  test("wraps a non-WriteBatchError into a structured INTERNAL_ERROR MCPError", () => {
    const mapped = writeBatchErrorToMcp(new Error("disk exploded"), "brain_update_note");
    expect(mapped).toBeInstanceOf(MCPError);
    expect(mapped.code).toBe(INTERNAL_ERROR);
    expect(mapped.message).toContain("disk exploded");
  });

  test("maps a WriteBatchError onto a structured INVALID_PARAMS", () => {
    const mapped = writeBatchErrorToMcp(
      new WriteBatchError("target_missing", 2, "note does not exist", { path: "Notes/x.md" }),
      "brain_write_batch",
    );
    expect(mapped).toBeInstanceOf(MCPError);
    expect(mapped.code).toBe(INVALID_PARAMS);
    expect(mapped.data).toMatchObject({ code: "target_missing", index: 2, path: "Notes/x.md" });
  });
});
