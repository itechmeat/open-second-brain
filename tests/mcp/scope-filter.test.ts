import { describe, expect, test } from "bun:test";
import { buildToolTable } from "../../src/mcp/tools.ts";

describe("buildToolTable scope filter", () => {
  test("default scope returns the full surface", () => {
    const full = buildToolTable();
    const names = full.map((t) => t.name);
    expect(names).toContain("brain_feedback");
    expect(names).toContain("brain_apply_evidence");
    expect(names).toContain("brain_dream");
    expect(names).toContain("payment_memory_init");
    expect(names).toContain("vault_health");
    expect(full.length).toBeGreaterThanOrEqual(15);
  });

  test("writer scope returns exactly the two writer tools", () => {
    const writer = buildToolTable("writer");
    const names = writer.map((t) => t.name).sort();
    expect(names).toEqual(["brain_apply_evidence", "brain_feedback"]);
  });

  test("writer-scope schemas are the same instances as full scope", () => {
    const full = buildToolTable("full");
    const writer = buildToolTable("writer");
    for (const w of writer) {
      const matched = full.find((t) => t.name === w.name);
      expect(matched).toBeDefined();
      expect(w.inputSchema).toEqual(matched!.inputSchema);
      expect(w.description).toEqual(matched!.description);
    }
  });
});
