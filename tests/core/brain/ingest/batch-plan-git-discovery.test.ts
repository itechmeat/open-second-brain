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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("a subpath cannot silently re-enter an ignored subtree", () => {
  test("a subpath under an ignored directory plans nothing and says so", () => {
    write("mono/pkg/a/keep.md");
    write("mono/.gitignore", "pkg/\n");
    // Whole-tree planning already treats the subtree as ignored...
    expect(plannedPaths(planBatches(vault, SOURCE, CAPS))).toEqual([]);
    // ...and naming a directory inside it does not change the answer.
    const scoped = planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "pkg/a" });
    expect(plannedPaths(scoped)).toEqual([]);
    expect(scoped.ignoreWarnings).toHaveLength(1);
    const warning = scoped.ignoreWarnings[0]!;
    expect(warning.source).toBe("--src-subpath");
    expect(warning.pattern).toBe("pkg/a");
    expect(warning.reason).toContain("mono/pkg");
  });

  test("the slashless ignore form prunes the subpath walk too", () => {
    write("mono/pkg/a/keep.md");
    write("mono/.gitignore", "pkg\n");
    const scoped = planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "pkg/a" });
    expect(plannedPaths(scoped)).toEqual([]);
    expect(scoped.ignoreWarnings).toHaveLength(1);
  });

  test("the walk root itself being the ignored directory is pruned", () => {
    write("mono/pkg/keep.md");
    write("mono/.gitignore", "pkg/\n");
    const scoped = planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "pkg" });
    expect(plannedPaths(scoped)).toEqual([]);
    expect(scoped.ignoreWarnings).toHaveLength(1);
  });

  test("an --exclude re-include is the explicit way to walk it anyway", () => {
    write("mono/pkg/a/keep.md");
    write("mono/.gitignore", "pkg/\n");
    const scoped = planBatches(vault, SOURCE, {
      ...CAPS,
      srcSubpath: "pkg/a",
      exclude: ["!pkg/"],
    });
    expect(plannedPaths(scoped)).toEqual(["mono/pkg/a/keep.md"]);
    expect(scoped.ignoreWarnings).toEqual([]);
  });

  test("a subpath under a directory the repository never ignored is unaffected", () => {
    write("mono/pkg/a/keep.md");
    write("mono/.gitignore", "other/\n");
    const scoped = planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "pkg/a" });
    expect(plannedPaths(scoped)).toEqual(["mono/pkg/a/keep.md"]);
    expect(scoped.ignoreWarnings).toEqual([]);
  });
});

describe("a subpath cannot cross a nested repository boundary", () => {
  test("a subpath inside a submodule is refused", () => {
    write("mono/sub/inner/x.md");
    write("mono/sub/.git", "gitdir: ../.git/modules/sub\n");
    // The unscoped walk already refuses to attribute those files to this tree.
    expect(plannedPaths(planBatches(vault, SOURCE, CAPS))).toEqual([]);
    expect(() => planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "sub/inner" })).toThrow(
      /nested repository boundary/,
    );
  });

  test("a subpath equal to the submodule root is refused", () => {
    write("mono/sub/inner.md");
    write("mono/sub/.git", "gitdir: ../.git/modules/sub\n");
    expect(() => planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "sub" })).toThrow(
      /nested repository boundary/,
    );
  });

  test("a subpath inside a nested independent checkout is refused", () => {
    write("mono/vendor/inner/x.md");
    mkdirSync(join(vault, "mono", "vendor", ".git"), { recursive: true });
    expect(() => planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "vendor/inner" })).toThrow(
      /nested repository boundary/,
    );
  });

  test("an --exclude re-include cannot open a repository boundary", () => {
    write("mono/sub/inner/x.md");
    write("mono/sub/.git", "gitdir: ../.git/modules/sub\n");
    expect(() =>
      planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "sub/inner", exclude: ["!sub/"] }),
    ).toThrow(/nested repository boundary/);
  });

  test("an ordinary intermediate directory is still descended into", () => {
    write("mono/plain/inner/x.md");
    const plan = planBatches(vault, SOURCE, { ...CAPS, srcSubpath: "plain/inner" });
    expect(plannedPaths(plan)).toEqual(["mono/plain/inner/x.md"]);
  });
});

describe("an ignore file that cannot be honoured reaches the plan", () => {
  test("an unreadable .gitignore is a structured plan warning, not a silent pass", () => {
    write("mono/secret.md");
    write("mono/.gitignore", "secret.md\n");
    chmodSync(join(vault, "mono", ".gitignore"), 0o000);
    const plan = planBatches(vault, SOURCE, CAPS);
    // The file the repository declared excluded is still queued - but never
    // without a signal saying why the declaration was not applied.
    expect(plannedPaths(plan)).toEqual(["mono/secret.md"]);
    expect(plan.ignoreWarnings).toHaveLength(1);
    expect(plan.ignoreWarnings[0]!.source).toBe("mono/.gitignore");
    expect(plan.ignoreWarnings[0]!.reason).toContain("EACCES");
  });

  test("a symlinked .gitignore is refused with a warning", () => {
    write("mono/secret.md");
    write("elsewhere/rules", "secret.md\n");
    symlinkSync(join(vault, "elsewhere", "rules"), join(vault, "mono", ".gitignore"));
    const plan = planBatches(vault, SOURCE, CAPS);
    expect(plannedPaths(plan)).toEqual(["mono/secret.md"]);
    expect(plan.ignoreWarnings).toHaveLength(1);
    expect(plan.ignoreWarnings[0]!.reason).toContain("symbolic link");
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
