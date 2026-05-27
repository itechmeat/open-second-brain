import { describe, expect, test } from "bun:test";
import { planAction } from "../../../src/core/brain/claude-memory-plan.ts";

describe("planAction", () => {
  const make = (overrides: Partial<Parameters<typeof planAction>[0]>) =>
    planAction({
      basename: "x.md",
      prefId: "pref-x",
      sha256: "h",
      inManifest: null,
      prefExists: false,
      ...overrides,
    });

  test("no manifest + no pref → CREATE", () => {
    expect(make({}).action).toBe("CREATE");
  });
  test("no manifest + pref exists → CONFLICT", () => {
    expect(make({ prefExists: true }).action).toBe("CONFLICT");
  });
  test("manifest matches + pref exists → SKIP_UNCHANGED", () => {
    expect(make({ inManifest: { sha256: "h" }, prefExists: true }).action).toBe("SKIP_UNCHANGED");
  });
  test("manifest matches + pref missing → RECREATE", () => {
    expect(make({ inManifest: { sha256: "h" }, prefExists: false }).action).toBe("RECREATE");
  });
  test("manifest differs + pref exists → UPDATE", () => {
    expect(make({ inManifest: { sha256: "old" }, prefExists: true }).action).toBe("UPDATE");
  });
  test("manifest differs + pref missing → CREATE (manifest stale)", () => {
    expect(make({ inManifest: { sha256: "old" }, prefExists: false }).action).toBe("CREATE");
  });
});
