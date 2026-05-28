import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

let vault: string;
let ctx: { vault: string; configPath: string };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-monthly-mcp-"));
  mkdirSync(brainDirs(vault).log, { recursive: true });
  ctx = { vault, configPath: join(vault, "config.yaml") };
  appendLogEvent(vault, {
    timestamp: "2026-05-10T10:00:00Z",
    eventType: BRAIN_LOG_EVENT_KIND.feedback,
    body: { topic: "monthly", sign: "positive", agent: "test" },
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("brain_monthly_review MCP tool", () => {
  test("is registered and returns monthly summary", async () => {
    const tool = BRAIN_TOOLS.find(
      (entry) => entry.name === "brain_monthly_review",
    );
    expect(tool).toBeDefined();
    const out = (await tool!.handler(ctx as any, {
      month: "2026-05",
    })) as Record<string, unknown>;
    expect(out["month"]).toBe("2026-05");
    expect((out["summary"] as Record<string, unknown>)["events"]).toBe(1);
  });
});
