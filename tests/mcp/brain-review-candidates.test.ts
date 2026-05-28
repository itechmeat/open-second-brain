/**
 * `brain_review_candidates` MCP tool wiring. Exercises the tool
 * through the same path the MCP server uses: tool lookup, handler
 * invocation, response shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
// Minimal shape - the brain_review_candidates handler only reads
// `ctx.vault`. We construct a structural match and cast to the
// handler's parameter type at the call site.
let ctx: { vault: string; configPath: string };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rc-mcp-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rc-mcp-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath };
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_review_candidates MCP tool", () => {
  test("is registered in BRAIN_TOOLS", () => {
    const tool = BRAIN_TOOLS.find((t) => t.name === "brain_review_candidates");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("preview");
    expect(tool?.inputSchema).toBeDefined();
  });

  test("returns the review fields, all empty on a fresh vault", async () => {
    const tool = BRAIN_TOOLS.find((t) => t.name === "brain_review_candidates");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, {
      now: "2026-05-27T12:00:00Z",
    })) as Record<string, unknown>;
    expect(out["would_create"]).toEqual([]);
    expect(out["would_promote"]).toEqual([]);
    expect(out["would_retire"]).toEqual([]);
    expect(out["would_supersede"]).toEqual([]);
    expect(out["clusters_below_threshold"]).toEqual([]);
    expect(out["gated_retires"]).toEqual([]);
    expect(out["intent_reviews"]).toEqual([]);
  });
});
