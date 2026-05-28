import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

let vault: string;
let ctx: { vault: string; configPath: string };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-intent-review-mcp-"));
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
  ctx = { vault, configPath: join(vault, "config.yaml") };
  for (let index = 0; index < 3; index++) {
    writeSignal(vault, {
      topic: "ready-topic",
      signal: "positive",
      agent: "test",
      principle: "ready topic principle",
      created_at: `2026-05-2${index + 1}T10:00:00Z`,
      date: `2026-05-2${index + 1}`,
      slug: `ready-topic-${index}`,
    });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("brain_intent_review MCP tool", () => {
  test("is registered and returns review entries", async () => {
    const tool = BRAIN_TOOLS.find(
      (entry) => entry.name === "brain_intent_review",
    );
    expect(tool).toBeDefined();
    const out = (await tool!.handler(ctx as any, {
      now: "2026-05-28T00:00:00Z",
    })) as Record<string, unknown>;
    expect(out["schema_version"]).toBe(1);
    expect(out["reviews"]).toEqual([
      expect.objectContaining({
        topic: "ready-topic",
        decision: "ready_for_main_review",
      }),
    ]);
  });
});
