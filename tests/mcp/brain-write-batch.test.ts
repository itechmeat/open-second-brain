/**
 * MCP integration tests for `brain_write_batch` (W2, t_7718ab22): the
 * general atomic batch write tool, the second consumer of kernel 2.
 *
 * A mixed batch commits all-or-nothing; the first invalid operation
 * aborts with a typed error naming the operation index and no disk write
 * happens. Single-operation batches produce results equal to the
 * dedicated brain_create_note / brain_update_note / brain_append_note
 * tools.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { WRITE_BATCH_TOOLS } from "../../src/mcp/brain/write-batch-tools.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import { MAX_BATCH_OPERATIONS } from "../../src/core/brain/write-batch.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-batch-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-write-batch-cfg-"));
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

function writePref(slug: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${slug}`,
      "_status: confirmed",
      "principle: always test first",
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

const tool = WRITE_BATCH_TOOLS.find((t) => t.name === "brain_write_batch")!;

type BatchResponse = {
  readonly applied: number;
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly done: true;
};

async function runBatch(operations: unknown[]): Promise<BatchResponse> {
  return (await tool.handler(ctx, { operations })) as unknown as BatchResponse;
}

describe("brain_write_batch", () => {
  test("is registered and requires operations", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("operations");
  });

  test("commits a mixed batch all-or-nothing", async () => {
    writePref("test-first");
    seedNote("Notes/Existing.md", "old", "title: E");
    const res = await runBatch([
      { op: "create_note", path: "Notes/New.md", content: "fresh" },
      { op: "update_note", path: "Notes/Existing.md", content: "updated" },
      {
        op: "apply_evidence",
        pref_id: "test-first",
        artifact: "[[Notes/New.md]]",
        result: "applied",
      },
      { op: "append_log_line", text: "batch landed" },
    ]);
    expect(res.applied).toBe(4);
    expect(existsSync(join(vault, "Notes/New.md"))).toBe(true);
    expect(readFileSync(join(vault, "Notes/Existing.md"), "utf8")).toContain("updated");
  });

  test("a later invalid op aborts the batch: earlier ops do not land", async () => {
    await expect(
      tool.handler(ctx, {
        operations: [
          { op: "create_note", path: "Notes/First.md", content: "one" },
          // op 1 is invalid: the preference does not exist.
          { op: "apply_evidence", pref_id: "ghost", artifact: "[[x]]", result: "applied" },
        ],
      }),
    ).rejects.toThrow(MCPError);
    // Op 0 must not have landed.
    expect(existsSync(join(vault, "Notes/First.md"))).toBe(false);
  });

  test("the typed error names the offending operation index", async () => {
    let thrown: unknown;
    try {
      await tool.handler(ctx, {
        operations: [
          { op: "create_note", path: "Notes/Ok.md", content: "x" },
          { op: "update_note", path: "Notes/Ghost.md", content: "y" },
        ],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).data).toMatchObject({ index: 1, code: "target_missing" });
    expect(existsSync(join(vault, "Notes/Ok.md"))).toBe(false);
  });

  test("an empty operations array is rejected", async () => {
    await expect(tool.handler(ctx, { operations: [] })).rejects.toThrow(MCPError);
  });

  test("a batch over the operation cap is rejected before any write", async () => {
    const tooMany = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, i) => ({
      op: "create_note",
      path: `Notes/Over-${i}.md`,
      content: "x",
    }));
    let thrown: unknown;
    try {
      await tool.handler(ctx, { operations: tooMany });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).data).toMatchObject({
      code: "too_many_operations",
      index: -1,
      max: MAX_BATCH_OPERATIONS,
      count: MAX_BATCH_OPERATIONS + 1,
    });
    // Nothing landed: the cap is enforced during validation, before commit.
    expect(existsSync(join(vault, "Notes/Over-0.md"))).toBe(false);
  });

  test("the inputSchema advertises the operation cap via maxItems", () => {
    const schema = tool.inputSchema as {
      properties: { operations: { maxItems?: number } };
    };
    expect(schema.properties.operations.maxItems).toBe(MAX_BATCH_OPERATIONS);
  });

  test("single-op create parity with brain_create_note", async () => {
    const createTool = NOTES_TOOLS.find((t) => t.name === "brain_create_note")!;
    const direct = await createTool.handler(ctx, { path: "Notes/Direct.md", content: "d" });
    const batch = await runBatch([{ op: "create_note", path: "Notes/Batch.md", content: "d" }]);
    const batchResult = batch.results[0]!;
    expect(batchResult).toMatchObject({ kind: "create_note", created: true });
    expect(direct).toMatchObject({ created: true });
  });

  test("single-op update parity with brain_update_note", async () => {
    seedNote("Notes/A.md", "old", "title: A");
    seedNote("Notes/B.md", "old", "title: B");
    const updateTool = NOTES_TOOLS.find((t) => t.name === "brain_update_note")!;
    const direct = await updateTool.handler(ctx, { path: "Notes/A.md", content: "new" });
    const batch = await runBatch([{ op: "update_note", path: "Notes/B.md", content: "new" }]);
    const batchResult = batch.results[0]!;
    expect(direct).toMatchObject({ updated: true, path: "Notes/A.md" });
    expect(batchResult).toMatchObject({ kind: "update_note", updated: true, path: "Notes/B.md" });
    expect(readFileSync(join(vault, "Notes/A.md"), "utf8")).toBe(
      readFileSync(join(vault, "Notes/B.md"), "utf8").replace("title: B", "title: A"),
    );
  });

  test("single-op append parity with brain_append_note", async () => {
    seedNote("Notes/A.md", "base", "title: A");
    seedNote("Notes/B.md", "base", "title: A");
    const appendTool = NOTES_TOOLS.find((t) => t.name === "brain_append_note")!;
    await appendTool.handler(ctx, { path: "Notes/A.md", content: "more" });
    await tool.handler(ctx, {
      operations: [{ op: "append_note", path: "Notes/B.md", content: "more" }],
    });
    expect(readFileSync(join(vault, "Notes/A.md"), "utf8")).toBe(
      readFileSync(join(vault, "Notes/B.md"), "utf8"),
    );
  });

  test("refuses the Brain machinery root in a create op", async () => {
    await expect(
      tool.handler(ctx, { operations: [{ op: "create_note", path: "Brain/x.md", content: "y" }] }),
    ).rejects.toThrow(MCPError);
  });
});
