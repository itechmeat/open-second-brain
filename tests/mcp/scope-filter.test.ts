import { describe, expect, test } from "bun:test";
import { buildToolTable } from "../../src/mcp/tools.ts";

describe("buildToolTable scope filter", () => {
  test("default scope returns the full surface", () => {
    const full = buildToolTable();
    const names = full.map((t) => t.name);
    expect(names).toContain("brain_feedback");
    expect(names).toContain("brain_apply_evidence");
    expect(names).toContain("brain_dream");
    expect(names).toContain("vault_health");
    expect(full.length).toBeGreaterThanOrEqual(15);
  });

  test("writer scope returns writers plus brain_context (v0.16.0)", () => {
    const writer = buildToolTable("writer");
    const names = writer.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "brain_apply_evidence",
      "brain_context",
      "brain_feedback",
      "brain_note",
      "brain_pinned_context",
    ]);
  });

  test("writer-scope schemas are the same instances as full scope", () => {
    const full = buildToolTable("full");
    const writer = buildToolTable("writer");
    for (const w of writer) {
      const matched = full.find((t) => t.name === w.name);
      expect(matched).toBeDefined();
      // toBe asserts identity — writer scope filters from the same array,
      // so each retained ToolDefinition's schema/description must be the
      // same object instance. toEqual would silently allow accidental
      // cloning.
      expect(w.inputSchema).toBe(matched!.inputSchema);
      expect(w.description).toBe(matched!.description);
    }
  });
});
