import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMcpToolResult } from "../../src/mcp/server.ts";
import { ArtifactStore } from "../../src/mcp/artifact-store.ts";
import type { ToolDefinition } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let store: ArtifactStore;

function tool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: "synthetic_tool",
    description: "test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({}),
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-budget-dispatch-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  store = new ArtifactStore({ vault, runId: "run-dispatch" });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildMcpToolResult preview budget", () => {
  test("over-budget output: content is a preview envelope, structuredContent stays full", () => {
    const structured = {
      rows: Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(40) })),
    };
    const result = buildMcpToolResult(tool({ previewBudget: 300 }), structured, store);

    const content = result["content"] as Array<{ type: string; text: string }>;
    const env = JSON.parse(content[0]!.text);
    expect(env.preview_truncated).toBe(true);
    expect(typeof env.artifact_id).toBe("string");

    // structuredContent is untouched - full object, same identity.
    expect(result["structuredContent"]).toBe(structured);
    expect(result["isError"]).toBe(false);

    // The full payload is fetchable from the store.
    const back = store.get(env.artifact_id);
    expect(back).not.toBeNull();
    expect(JSON.parse(back!).rows).toHaveLength(200);
  });

  test("under-budget output is byte-identical to the plain serialization", () => {
    const structured = { ok: true, n: 3 };
    const budgeted = buildMcpToolResult(tool({ previewBudget: 10_000 }), structured, store);
    const content = budgeted["content"] as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(structured);
    expect(content[0]!.text).not.toContain("preview_truncated");
  });

  test("a tool with no budget is never truncated regardless of size", () => {
    const structured = {
      rows: Array.from({ length: 500 }, (_, i) => ({ i, pad: "y".repeat(40) })),
    };
    const result = buildMcpToolResult(tool({}), structured, store);
    const content = result["content"] as Array<{ type: string; text: string }>;
    expect(content[0]!.text).not.toContain("preview_truncated");
    expect(JSON.parse(content[0]!.text).rows).toHaveLength(500);
  });

  test("output-contract violations still throw before any truncation", () => {
    const badTool = tool({
      previewBudget: 10,
      outputSchema: { type: "object", required: ["must_have"], properties: {} },
    });
    expect(() => buildMcpToolResult(badTool, { other: 1 }, store)).toThrow(/must_have/);
  });
});
