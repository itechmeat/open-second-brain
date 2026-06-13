/**
 * MCP integration test for `brain_derive_fact` (Knowledge Provenance suite).
 * Opt-in behind the derived_fact_synthesis guardrail; the agent supplies the
 * conclusion and premises, OSB validates and commits with provenance.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { brainConfigPath, preferencePath } from "../../src/core/brain/paths.ts";
import { writePreference, parsePreference } from "../../src/core/brain/preference.ts";
import { DERIVE_TOOLS } from "../../src/mcp/brain/derive-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tools.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-derive-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-derive-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = DERIVE_TOOLS[0]!.handler;

function enableDerivation(): void {
  writeFileSync(
    brainConfigPath(vault),
    "schema_version: 1\nguardrails:\n  derived_fact_synthesis: true\n",
  );
}

function seedPremise(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `premise ${slug}`,
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-07-01T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
  });
}

const ARGS = {
  slug: "derived-1",
  topic: "derived",
  principle: "Therefore C",
  premises: ["pref-a", "pref-b"],
  level: "deduced",
};

describe("brain_derive_fact", () => {
  test("flag off (default): refuses with INVALID_PARAMS, writes nothing", async () => {
    seedPremise("a");
    seedPremise("b");
    await expect(handler(ctx, ARGS)).rejects.toThrow(MCPError);
  });

  test("flag on: commits the derived fact with its provenance level", async () => {
    seedPremise("a");
    seedPremise("b");
    enableDerivation();
    const res = await handler(ctx, ARGS);
    expect(res).toMatchObject({ id: "pref-derived-1", level: "deduced" });
    expect(parsePreference(preferencePath(vault, "derived-1")).provenance).toBe("deduced");
  });

  test("flag on: a missing premise is INVALID_PARAMS", async () => {
    seedPremise("a");
    enableDerivation();
    await expect(handler(ctx, ARGS)).rejects.toThrow(MCPError);
  });

  test("flag on: a 'stated' level is rejected", async () => {
    seedPremise("a");
    seedPremise("b");
    enableDerivation();
    await expect(handler(ctx, { ...ARGS, level: "stated" })).rejects.toThrow(MCPError);
  });
});
