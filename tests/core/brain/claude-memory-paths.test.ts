import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSafeMemoryPath } from "../../../src/core/brain/claude-memory-paths.ts";

describe("assertSafeMemoryPath", () => {
  test("default home → no throw", () => {
    assertSafeMemoryPath(join(homedir(), ".claude", "projects", "-x", "memory"), false);
  });
  test("system path without override → throws", () => {
    expect(() => assertSafeMemoryPath("/etc", false)).toThrow(/not under/);
  });
  test("system path with override → no throw", () => {
    assertSafeMemoryPath("/etc", true);
  });
});
