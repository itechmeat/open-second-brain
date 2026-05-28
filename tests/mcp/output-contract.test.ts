import { describe, expect, test } from "bun:test";

import {
  assertOutputContract,
  validateOutputContract,
  type OutputSchema,
} from "../../src/mcp/output-contract.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

describe("validateOutputContract", () => {
  test("accepts objects that satisfy required properties", () => {
    const schema: OutputSchema = {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
      additionalProperties: false,
    };
    expect(validateOutputContract(schema, { ok: true })).toEqual([]);
  });

  test("reports missing required properties", () => {
    const schema: OutputSchema = {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    };
    expect(validateOutputContract(schema, {})).toEqual(["$: missing required property 'ok'"]);
  });

  test("reports unexpected properties when additionalProperties is false", () => {
    const schema: OutputSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      additionalProperties: false,
    };
    expect(validateOutputContract(schema, { ok: true, extra: 1 })).toEqual([
      "$: unexpected property 'extra'",
    ]);
  });

  test("validates arrays, items, and enum values", () => {
    const schema: OutputSchema = {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["kind"],
            properties: { kind: { type: "string", enum: ["a", "b"] } },
          },
        },
      },
    };
    expect(validateOutputContract(schema, { items: [{ kind: "c" }] })).toEqual([
      "$.items[0].kind: expected one of a, b",
    ]);
  });
});

describe("assertOutputContract", () => {
  test("throws with tool name and validation details", () => {
    const schema: OutputSchema = {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    };
    expect(() => assertOutputContract("demo_tool", schema, { ok: "yes" })).toThrow(
      /demo_tool output contract failed: \$\.ok: expected boolean/,
    );
  });
});

describe("registered output contracts", () => {
  test("covers the first agent-facing structured surfaces", () => {
    const tools = new Map(buildToolTable("full").map((tool) => [tool.name, tool]));
    for (const name of ["brain_context", "brain_pinned_context", "brain_query", "brain_search"]) {
      expect(tools.get(name)?.outputSchema).toBeDefined();
    }
  });
});
