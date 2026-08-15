/**
 * MCP integration test for `brain_distill_source` (t_2e2e959f). The agent
 * supplies atomic claims with optional block ids; OSB writes an idempotent
 * distillation page. Handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { hashFile } from "../../src/core/brain/ingest/content-manifest.ts";
import {
  INTAKE_TRUST,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
} from "../../src/core/brain/trust/untrusted-provenance.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { DISTILL_TOOLS } from "../../src/mcp/brain/distill-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-distill-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, "Articles", "src.md"), "# Src\n\nBody.\n", "utf8");
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = DISTILL_TOOLS[0]!.handler;

describe("brain_distill_source", () => {
  test("writes a distillation page and returns its path", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/src.md",
      claims: [{ text: "An atomic claim.", block: "^abc" }, { text: "Another claim." }],
    })) as { distillation_path: string; claim_count: number };
    expect(res.claim_count).toBe(2);
    const md = readFileSync(join(vault, res.distillation_path), "utf8");
    expect(md).toContain("kind: brain-distillation");
    expect(md).toContain("([[Articles/src.md#^abc]])");
  });

  test("a non-empty claims array is required", async () => {
    await expect(handler(ctx, { source_path: "Articles/src.md", claims: [] })).rejects.toThrow(
      MCPError,
    );
  });

  test("missing source_path is rejected", async () => {
    await expect(handler(ctx, { claims: [{ text: "x" }] })).rejects.toThrow(MCPError);
  });
});

/**
 * The lane reaches the caller (wiring-what-exists, A1). Before this unit the
 * tool wrote every distillation under `provenance: stated` and returned a
 * `source_hash` of the literal string `missing` for a source with no bytes, so
 * a caller had no way to learn that what it just wrote is quarantined from
 * ordinary reads.
 */
describe("brain_distill_source - the response names the lane it committed in", () => {
  test("a source with a real file behind it is trusted and carries its digest", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/src.md",
      claims: [{ text: "A claim." }],
    })) as { trust: string; source_hash?: string };
    expect(res.trust).toBe(INTAKE_TRUST.trusted);
    expect(res.source_hash).toBe(hashFile(join(vault, "Articles", "src.md")));
  });

  test("a source that names no file is untrusted and reports no digest at all", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/absent.md",
      claims: [{ text: "A claim." }],
    })) as { trust: string; source_hash?: string };
    expect(res.trust).toBe(INTAKE_TRUST.untrusted);
    expect(res.source_hash).toBeUndefined();
  });

  test("the description states the guarantee, as the intake tool's does", () => {
    // A caller choosing between tools reads the description, not this test;
    // pinning it keeps the promise and the behaviour from drifting apart.
    expect(DISTILL_TOOLS[0]!.description).toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
  });
});
