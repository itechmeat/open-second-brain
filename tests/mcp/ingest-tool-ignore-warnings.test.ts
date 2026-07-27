/**
 * t_4b2bd8f7 follow-through: `brain_ingest_batch_plan`'s MCP payload surfaces
 * the planner's `ignoreWarnings` (a malformed pattern in the repository's OWN
 * ignore files) as structured fields, following the same "emit only when
 * non-empty" idiom `skipped_non_extractable` already uses. A clean tree must
 * serialize byte-identically to before: no key, not an empty array.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-tool-warn-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-tool-warn-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function write(rel: string, content = "hello\n"): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const batchPlan = INGEST_TOOLS.find((t) => t.name === "brain_ingest_batch_plan")!.handler;

describe("brain_ingest_batch_plan ignore_warnings (t_4b2bd8f7 follow-through)", () => {
  test("a malformed .gitignore pattern surfaces as a structured ignore_warnings entry", async () => {
    write("Docs/keep.md");
    write("Docs/.gitignore", "keep-nothing.md\n[unterminated\n");

    const res = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;

    expect(res["ignore_warnings"]).toEqual([
      {
        source: "Docs/.gitignore",
        line: 2,
        pattern: "[unterminated",
        reason: expect.stringContaining("unterminated"),
      },
    ]);
    // The plan still succeeds and the file is still discovered (nothing is
    // silently dropped by the malformed pattern).
    expect(res["total_files"]).toBe(1);
    expect(typeof res["plan_id"]).toBe("string");
  });

  test("a warning never changes the plan's planId versus the same tree without it", async () => {
    write("Docs/keep.md");
    const clean = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;

    write("Docs/.gitignore", "[unterminated\n");
    const withWarning = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;

    expect(withWarning["plan_id"]).toBe(clean["plan_id"]);
    expect(withWarning["total_files"]).toBe(1);
  });

  test("a clean tree produces a byte-identical payload: the key is absent, not empty", async () => {
    write("Docs/a.md");
    write("Docs/b.md");

    const res = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;

    expect("ignore_warnings" in res).toBe(false);
    expect(res).not.toHaveProperty("ignore_warnings");
  });
});
