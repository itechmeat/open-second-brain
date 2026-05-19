import { describe, expect, test } from "bun:test";
import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";

describe("import-claude-memory log kind", () => {
  test("kind is registered as 'import-claude-memory'", () => {
    expect(BRAIN_LOG_EVENT_KIND.importClaudeMemory).toBe("import-claude-memory");
  });
});
