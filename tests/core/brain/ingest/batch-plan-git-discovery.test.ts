/**
 * Unit 1 (t_4b2bd8f7): the ingest batch planner honours the repository's own
 * ignore declarations through the shared git-aware discovery module - root and
 * nested `.gitignore`, `.git/info/exclude`, and submodule boundaries - while the
 * operator's `--exclude` layer keeps winning over every one of them.
 *
 * A tree carrying no ignore files must plan byte-identically to before, planId
 * included.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";
import { computePlanId } from "../../../../src/core/brain/ingest/checkpoint.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-gitdisc-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-gitdisc-cfg-"));
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
const SOURCE = "mono";

describe("repository-declared ignore layers", () => {
  test("a .gitignore in the source dir excludes the paths it declares", () => {
    write("mono/keep.md");
    write("mono/build/out.md");
    write("mono/scratch.tmp.md");
    write("mono/.gitignore", "build/\n*.tmp.md\n");
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/keep.md"]);
  });

  test("a nested .gitignore applies to its own subtree only", () => {
    write("mono/pkg/drop.md");
    write("mono/pkg/keep.md");
    write("mono/other/drop.md");
    write("mono/pkg/.gitignore", "drop.md\n");
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/other/drop.md", "mono/pkg/keep.md"]);
  });

  test("a nearer ! re-include wins over the source-dir .gitignore", () => {
    write("mono/skip/important.md");
    write("mono/keep/important.md");
    write("mono/.gitignore", "important.md\n");
    write("mono/keep/.gitignore", "!important.md\n");
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/keep/important.md"]);
  });

  test(".git/info/exclude is layered beneath the root .gitignore", () => {
    write("mono/a.md");
    write("mono/secret.md");
    write("mono/.git/info/exclude", "secret.md\n");
    const excluded = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(excluded)).toEqual(["mono/a.md"]);

    // The root .gitignore sits ABOVE the exclude file, so its re-include wins.
    write("mono/.gitignore", "!secret.md\n");
    const reincluded = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(reincluded)).toEqual(["mono/a.md", "mono/secret.md"]);
  });

  test("the source dir's .gitignore still governs when discovery is subpath-scoped", () => {
    write("mono/pkg/a/keep.md");
    write("mono/pkg/a/drop.md");
    write("mono/.gitignore", "drop.md\n");
    const plan = planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "pkg/a" });
    expect(plannedPaths(plan)).toEqual(["mono/pkg/a/keep.md"]);
  });
});

describe("submodule boundaries", () => {
  test("a directory carrying a gitlink file is not descended into", () => {
    write("mono/keep.md");
    write("mono/sub/inner.md");
    write("mono/sub/.git", "gitdir: ../.git/modules/sub\n");
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/keep.md"]);
  });

  test("a directory carrying a nested .git directory is not descended into", () => {
    write("mono/keep.md");
    write("mono/vendor/inner.md");
    mkdirSync(join(vault, "mono", "vendor", ".git"), { recursive: true });
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/keep.md"]);
  });

  test("the source dir being a repository root does not prune the whole walk", () => {
    write("mono/keep.md");
    mkdirSync(join(vault, "mono", ".git"), { recursive: true });
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/keep.md"]);
  });
});

describe("operator --exclude wins over every repository layer", () => {
  test("--exclude drops a path the repository never declared", () => {
    write("mono/keep.md");
    write("mono/vendor/dep.md");
    write("mono/.gitignore", "nothing-here.md\n");
    const plan = planBatches(vault, SOURCE, { ...CAPS, exclude: ["vendor/"] });
    expect(plannedPaths(plan)).toEqual(["mono/keep.md"]);
  });

  test("an --exclude re-include overrides a repository-declared ignore", () => {
    write("mono/keep.md");
    write("mono/generated/out.md");
    write("mono/.gitignore", "generated/\n");
    const withoutOverride = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(withoutOverride)).toEqual(["mono/keep.md"]);

    const plan = planBatches(vault, SOURCE, { ...CAPS, exclude: ["!generated/"] });
    expect(plannedPaths(plan)).toEqual(["mono/generated/out.md", "mono/keep.md"]);
  });

  test("--exclude also overrides a nested .gitignore", () => {
    write("mono/pkg/drop.md");
    write("mono/pkg/.gitignore", "drop.md\n");
    const plan = planBatches(vault, SOURCE, { ...CAPS, exclude: ["!drop.md"] });
    expect(plannedPaths(plan)).toEqual(["mono/pkg/drop.md"]);
  });
});

describe("byte-identical no-git path", () => {
  test("a tree with no ignore files produces the planId it produces today", () => {
    write("mono/a.md");
    write("mono/sub/b.md");
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/a.md", "mono/sub/b.md"]);
    // Pinned against the documented derivation rather than against the walk, so
    // the assertion cannot drift with the discovery implementation.
    expect(plan.planId).toBe(computePlanId(SOURCE, ["mono/a.md", "mono/sub/b.md"]));
    expect(plan.ignoreWarnings).toEqual([]);
  });

  test("an empty --exclude list is identical to no --exclude at all", () => {
    write("mono/a.md");
    write("mono/sub/b.md");
    const baseline = planBatches(vault, SOURCE, CAPS);
    const withEmpty = planBatches(vault, SOURCE, { ...CAPS, exclude: [] });
    expect(withEmpty.planId).toBe(baseline.planId);
    expect(plannedPaths(withEmpty)).toEqual(plannedPaths(baseline));
  });
});

describe("malformed patterns", () => {
  test("a malformed repository pattern is a structured plan warning, not a failure", () => {
    write("mono/keep.md");
    write("mono/[weird.md");
    write("mono/.gitignore", "keep-nothing.md\n[unterminated\n");
    const plan = planBatches(vault, SOURCE, CAPS);
    // No rule was produced, so nothing was silently dropped.
    expect(plannedPaths(plan)).toEqual(["mono/[weird.md", "mono/keep.md"]);
    expect(plan.ignoreWarnings).toHaveLength(1);
    const warning = plan.ignoreWarnings[0]!;
    expect(warning.source).toBe("mono/.gitignore");
    expect(warning.line).toBe(2);
    expect(warning.pattern).toBe("[unterminated");
    expect(warning.reason).toContain("unterminated");
  });

  test("a malformed pattern in a nested .gitignore names that file", () => {
    write("mono/pkg/keep.md");
    write("mono/pkg/.gitignore", "[unterminated\n");
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/pkg/keep.md"]);
    expect(plan.ignoreWarnings.map((w) => w.source)).toEqual(["mono/pkg/.gitignore"]);
  });

  test("a malformed operator --exclude pattern still throws", () => {
    write("mono/keep.md");
    expect(() => planBatches(vault, SOURCE, { ...CAPS, exclude: ["[unterminated"] })).toThrow(
      /malformed --exclude pattern/,
    );
  });
});
