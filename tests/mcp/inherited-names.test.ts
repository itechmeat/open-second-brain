/**
 * A name the caller supplies is looked up among a table's OWN names only.
 * Read through a plain object, an inherited name (`constructor`,
 * `toString`, `__proto__`) once found a built-in, so a view or a tool of
 * that name was answered instead of being refused as unknown.
 */
import { describe, expect, test } from "bun:test";

import { MCPError, METHOD_NOT_FOUND } from "../../src/mcp/protocol.ts";
import { dispatchByView } from "../../src/mcp/brain/shared.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const INHERITED = ["constructor", "toString", "hasOwnProperty", "__proto__"] as const;

/** A context to pass the view dispatcher; the refusal happens before it is read. */
const CTX = {
  vault: "/a/host/path",
  configPath: "/a/host/config.yaml",
} as unknown as ServerContext;

function refusal(fn: () => unknown): { code: number; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof MCPError)) throw err;
    return { code: err.code, message: err.message };
  }
}

describe("inherited names", () => {
  test("a consolidated view refuses them as unknown views", () => {
    const table = { morning: () => "a brief" };
    for (const view of INHERITED) {
      const answer = refusal(() => dispatchByView(table, CTX, { view }));
      expect({ view, refused: answer?.message.startsWith("view must be one of morning") }).toEqual({
        view,
        refused: true,
      });
    }
  });

  test("schema_inspect refuses them before it reads anything", () => {
    const tool = findTool(buildToolTable("full"), "schema_inspect");
    for (const view of INHERITED) {
      const answer = refusal(() => tool.handler(CTX, { view }));
      expect({ view, refused: answer?.message.startsWith("view must be one of") }).toEqual({
        view,
        refused: true,
      });
    }
  });

  test("a tool call names them unknown tools, not removed ones", () => {
    const tools = buildToolTable("full");
    for (const name of INHERITED) {
      expect({ name, answer: refusal(() => findTool(tools, name)) }).toEqual({
        name,
        answer: { code: METHOD_NOT_FOUND, message: `unknown tool: ${name}` },
      });
    }
  });
});
