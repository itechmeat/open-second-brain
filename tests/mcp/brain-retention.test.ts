import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { processedSignalPath, signalPath } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

let vault: string;
let ctx: { vault: string; configPath: string };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-retention-mcp-"));
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
  ctx = { vault, configPath: join(vault, "config.yaml") };
  writeSignal(vault, {
    topic: "discarded-signal",
    signal: "negative",
    agent: "test",
    principle: "old one-off signal",
    created_at: "2026-04-01T00:00:00Z",
    date: "2026-04-01",
    slug: "discarded-signal",
  });
  renameSync(
    signalPath(vault, "2026-04-01", "discarded-signal"),
    processedSignalPath(vault, "2026-04-01", "discarded-signal"),
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("brain_retention MCP tool", () => {
  test("is registered and returns recommendations", async () => {
    const tool = BRAIN_TOOLS.find((entry) => entry.name === "brain_retention");
    expect(tool).toBeDefined();
    const out = (await tool!.handler(ctx as any, {
      now: "2026-05-28T00:00:00Z",
    })) as Record<string, unknown>;
    expect((out["summary"] as Record<string, unknown>)["prune"]).toBe(1);
  });
});
