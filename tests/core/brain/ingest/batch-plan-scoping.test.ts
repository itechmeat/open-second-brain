/**
 * P2 (t_e82101a5): source-ingest scoping. `planBatches` gains `--src-subpath`
 * (restrict discovery to a subtree) and `--exclude` (gitignore-style patterns
 * via the shared src/core/fs/ignore.ts engine). Without the flags the plan is
 * byte-identical to today; a subpath escaping the source root is a typed error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
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

function plannedPaths(plan: ReturnType<typeof planBatches>): string[] {
  return plan.batches.flatMap((b) => b.files.map((f) => f.path)).toSorted();
}

const CAPS = { maxBatchBytes: 100_000, maxBatchFiles: 100 } as const;

describe("--src-subpath", () => {
  test("restricts discovery to the named subtree", () => {
    write("mono/pkg/a/one.md");
    write("mono/pkg/a/two.md");
    write("mono/pkg/b/three.md");
    const plan = planBatches(vault, "mono", { ...CAPS, srcSubpath: "pkg/a" });
    expect(plannedPaths(plan)).toEqual(["mono/pkg/a/one.md", "mono/pkg/a/two.md"]);
  });

  test("a subpath escaping the source root is a typed error", () => {
    write("mono/pkg/a/one.md");
    expect(() => planBatches(vault, "mono", { ...CAPS, srcSubpath: "../../etc" })).toThrow(
      /escapes|outside/i,
    );
  });

  test("a subpath that is not an existing directory throws", () => {
    write("mono/pkg/a/one.md");
    expect(() => planBatches(vault, "mono", { ...CAPS, srcSubpath: "pkg/missing" })).toThrow();
  });
});

describe("--exclude", () => {
  test("excludes files matching the pattern, composing with the ignore engine", () => {
    write("mono/keep.md");
    write("mono/vendor/dep.md");
    write("mono/vendor/nested/deep.md");
    write("mono/notes.tmp.md");
    const plan = planBatches(vault, "mono", {
      ...CAPS,
      exclude: ["vendor/", "*.tmp.md"],
    });
    expect(plannedPaths(plan)).toEqual(["mono/keep.md"]);
  });
});

describe("byte-identical opt-out", () => {
  test("without the new flags the plan matches the pre-flag output exactly", () => {
    write("mono/a.md");
    write("mono/sub/b.md");
    const baseline = planBatches(vault, "mono", CAPS);
    const withEmpty = planBatches(vault, "mono", { ...CAPS, exclude: [] });
    expect(baseline.planId).toBe(withEmpty.planId);
    expect(plannedPaths(baseline)).toEqual(["mono/a.md", "mono/sub/b.md"]);
    expect(plannedPaths(withEmpty)).toEqual(plannedPaths(baseline));
    expect(withEmpty.sourceDir).toBe(baseline.sourceDir);
  });
});
