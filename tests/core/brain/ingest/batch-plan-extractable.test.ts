/**
 * P3 (t_ed856388): planBatches honors the schema `extractable` allowlist during
 * discovery. Non-extractable pages are skipped-with-reason and reported on the
 * plan; with no allowlist the plan is byte-identical to before the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-extract-plan-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-extract-plan-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function page(rel: string, schemaType?: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const fm = schemaType === undefined ? "" : `schema_type: ${schemaType}\n`;
  writeFileSync(abs, `---\ntitle: ${rel}\n${fm}---\n\nbody text\n`, "utf8");
}

/** Point the schema pack at an extractable allowlist. */
function setExtractable(tokens: string[]): void {
  const block = tokens.map((t) => `    - ${t}`).join("\n");
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    `schema_version: 1\nschema:\n  page_types:\n    - paper\n    - memo\n  extractable:\n${block}\n`,
    "utf8",
  );
}

const CAPS = { maxBatchBytes: 100_000, maxBatchFiles: 100 } as const;

function plannedPaths(plan: ReturnType<typeof planBatches>): string[] {
  return plan.batches.flatMap((b) => b.files.map((f) => f.path)).toSorted();
}

describe("extractable gate in planBatches", () => {
  test("skips non-extractable pages and reports them with a reason", () => {
    page("Sources/a.md", "paper");
    page("Sources/b.md", "memo");
    page("Sources/c.md", "paper");
    setExtractable(["paper"]);

    const plan = planBatches(vault, "Sources", CAPS);
    expect(plannedPaths(plan)).toEqual(["Sources/a.md", "Sources/c.md"]);
    expect(plan.skippedNonExtractable.map((s) => s.path)).toEqual(["Sources/b.md"]);
    expect(plan.skippedNonExtractable[0]!.reason).toContain("memo");
  });

  test("with no allowlist the plan is byte-identical (empty gate report)", () => {
    page("Sources/a.md", "paper");
    page("Sources/b.md", "memo");
    // Default bootstrap has no extractable declaration.
    const plan = planBatches(vault, "Sources", CAPS);
    expect(plan.skippedNonExtractable).toEqual([]);
    expect(plannedPaths(plan)).toEqual(["Sources/a.md", "Sources/b.md"]);
  });

  test("no schema mutation surface changes: reading the pack does not write it", () => {
    page("Sources/a.md", "memo");
    setExtractable(["paper"]);
    const before = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    planBatches(vault, "Sources", CAPS);
    const after = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(after).toBe(before);
  });
});
