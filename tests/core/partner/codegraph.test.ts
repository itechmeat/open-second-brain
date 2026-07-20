import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkCodegraph,
  defaultDetectProjectPathSupport,
  findCodeProjects,
  isCodeProject,
} from "../../../src/core/partner/codegraph.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-codegraph-partner-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(dir: string, manifest: string = "package.json"): string {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, manifest), "{}\n");
  return dir;
}

function makeIndexed(dir: string): void {
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  writeFileSync(join(dir, ".codegraph", "codegraph.db"), "");
}

describe("isCodeProject", () => {
  test("empty directory is not a code project", () => {
    expect(isCodeProject(tmp)).toBe(false);
  });

  test(".git alone is not enough", () => {
    mkdirSync(join(tmp, ".git"));
    expect(isCodeProject(tmp)).toBe(false);
  });

  test("manifest alone is not enough", () => {
    writeFileSync(join(tmp, "package.json"), "{}\n");
    expect(isCodeProject(tmp)).toBe(false);
  });

  test(".git + package.json -> code project", () => {
    makeRepo(tmp);
    expect(isCodeProject(tmp)).toBe(true);
  });

  test(".git + tsconfig.json -> code project", () => {
    makeRepo(tmp, "tsconfig.json");
    expect(isCodeProject(tmp)).toBe(true);
  });

  test(".git + pyproject.toml -> code project", () => {
    makeRepo(tmp, "pyproject.toml");
    expect(isCodeProject(tmp)).toBe(true);
  });

  test(".git + Cargo.toml -> code project", () => {
    makeRepo(tmp, "Cargo.toml");
    expect(isCodeProject(tmp)).toBe(true);
  });

  test(".git + go.mod -> code project", () => {
    makeRepo(tmp, "go.mod");
    expect(isCodeProject(tmp)).toBe(true);
  });

  test("non-existent dir -> false", () => {
    expect(isCodeProject(join(tmp, "missing"))).toBe(false);
  });
});

describe("findCodeProjects", () => {
  test("cwd as a code project is included", () => {
    const repo = makeRepo(join(tmp, "repo"));
    const out = findCodeProjects({ cwd: repo, vault: join(tmp, "vault") });
    expect(out).toContain(repo);
  });

  test("empty scope yields empty result", () => {
    mkdirSync(join(tmp, "vault"));
    mkdirSync(join(tmp, "vault-sibling"));
    const out = findCodeProjects({ cwd: tmp, vault: join(tmp, "vault") });
    expect(out).toEqual([]);
  });

  test("vault parent siblings are inspected", () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const sibling = makeRepo(join(tmp, "my-app"));
    const out = findCodeProjects({ cwd: vault, vault });
    expect(out).toContain(sibling);
  });

  test("does not descend below depth 1 in vault parent", () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const nested = makeRepo(join(tmp, "outer", "inner", "deep-repo"));
    const out = findCodeProjects({ cwd: vault, vault });
    expect(out).not.toContain(nested);
  });

  test("honors scanExtraPaths", () => {
    mkdirSync(join(tmp, "vault"));
    const extra = makeRepo(join(tmp, "elsewhere", "ext-repo"));
    const out = findCodeProjects({
      cwd: join(tmp, "vault"),
      vault: join(tmp, "vault"),
      scanExtraPaths: [extra],
    });
    expect(out).toContain(extra);
  });

  test("dedupes overlapping scopes", () => {
    const repo = makeRepo(join(tmp, "repo"));
    const out = findCodeProjects({
      cwd: repo,
      vault: join(tmp, "vault"),
      scanExtraPaths: [repo],
    });
    expect(out.filter((p: string) => p === repo).length).toBe(1);
  });

  test("bails out at the scan limit", () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    for (let i = 0; i < 60; i++) {
      makeRepo(join(tmp, `repo-${i}`));
    }
    const out = findCodeProjects({ cwd: vault, vault, limit: 10 });
    expect(out.length).toBeLessThanOrEqual(10);
  });
});

describe("checkCodegraph", () => {
  test("null when nothing in scope is a code project", () => {
    mkdirSync(join(tmp, "vault"));
    const r = checkCodegraph(
      { cwd: tmp, vault: join(tmp, "vault") },
      { whichCodegraph: () => null },
    );
    expect(r).toBeNull();
  });

  test("null when disabled", () => {
    const repo = makeRepo(join(tmp, "repo"));
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault"), disabled: true },
      { whichCodegraph: () => "/usr/bin/codegraph" },
    );
    expect(r).toBeNull();
  });

  test("code project + no CLI -> skipped (codegraph is optional)", () => {
    // OSB never installs codegraph; its absence is normal, not a doctor
    // failure. When the CLI is not on PATH the check is skipped entirely so
    // `o2b doctor` stays green for the many users without codegraph.
    const repo = makeRepo(join(tmp, "repo"));
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      { whichCodegraph: () => null },
    );
    expect(r).toBeNull();
  });

  test("code project + CLI + no .codegraph/ -> not_indexed", () => {
    const repo = makeRepo(join(tmp, "repo"));
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      { whichCodegraph: () => "/usr/bin/codegraph" },
    );
    expect(r!.ok).toBe(false);
    expect(r!.message.toLowerCase()).toContain("not indexed");
    expect(r!.message).toContain("codegraph init");
  });

  test("code project + CLI + indexed + status ok -> ok", () => {
    const repo = makeRepo(join(tmp, "repo"));
    makeIndexed(repo);
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({
          ok: true,
          data: { initialized: true, nodeCount: 4737, fileCount: 392, edgeCount: 11342 },
        }),
      },
    );
    expect(r!.ok).toBe(true);
    expect(r!.message).toContain("4737");
    expect(r!.message).toContain("392");
  });

  test("indexed but unhealthy graph -> ok stays true, health summary in message", () => {
    // A cache-root mismatch (common in worktree checkouts) and collapsed edges
    // are non-blocking: doctor must not fail, but must surface the warning.
    const repo = makeRepo(join(tmp, "repo"));
    makeIndexed(repo);
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({
          ok: true,
          data: {
            initialized: true,
            nodeCount: 800,
            fileCount: 50,
            edgeCount: 0,
            worktreeMismatch: { worktreeRoot: "/other/root", indexRoot: "/repo" },
          },
        }),
      },
    );
    expect(r!.ok).toBe(true);
    expect(r!.message).toContain("graph-health");
    expect(r!.message).toContain("collapsed-edges");
    expect(r!.message).toContain("cache-root-mismatch");
  });

  test("indexed healthy graph -> no graph-health suffix", () => {
    const repo = makeRepo(join(tmp, "repo"));
    makeIndexed(repo);
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({
          ok: true,
          data: { initialized: true, nodeCount: 100, fileCount: 10, edgeCount: 250 },
        }),
      },
    );
    expect(r!.ok).toBe(true);
    expect(r!.message).not.toContain("graph-health");
  });

  test("status reports initialized:false -> not_indexed", () => {
    const repo = makeRepo(join(tmp, "repo"));
    makeIndexed(repo);
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({ ok: true, data: { initialized: false } }),
      },
    );
    expect(r!.ok).toBe(false);
    expect(r!.message.toLowerCase()).toContain("not indexed");
  });

  test("status returns an error -> error state surfaced", () => {
    const repo = makeRepo(join(tmp, "repo"));
    makeIndexed(repo);
    const r = checkCodegraph(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({ ok: false, error: "stale lock" }),
      },
    );
    expect(r!.ok).toBe(false);
    expect(r!.message.toLowerCase()).toContain("stale lock");
  });

  test("falls back to real PATH lookup when no whichCodegraph dep provided", () => {
    const repo = makeRepo(join(tmp, "repo"));
    // No injected dep -> real PATH lookup. The result is environment-dependent
    // (null when codegraph is not installed, a code_graph result when it is),
    // so assert only that the fallback wiring runs without throwing and yields
    // a well-formed value either way.
    const r = checkCodegraph({ cwd: repo, vault: join(tmp, "vault") });
    expect(r === null || r.name === "code_graph").toBe(true);
  });
});

const okStatus = (nodes: number, files: number) => ({
  ok: true as const,
  data: { initialized: true, nodeCount: nodes, fileCount: files, edgeCount: nodes * 2 },
});

describe("checkCodegraph across all workspace projects (W1)", () => {
  test("single-project workspace stays byte-identical and never probes project_path support", () => {
    const repo = makeRepo(join(tmp, "repo"));
    makeIndexed(repo);
    const args = {
      whichCodegraph: () => "/usr/bin/codegraph",
      // If project_path support were probed for a single project this would throw.
      detectProjectPathSupport: (): boolean => {
        throw new Error("must not probe for a single-project workspace");
      },
      runStatusJson: () => okStatus(100, 10),
    };
    const r = checkCodegraph({ cwd: repo, vault: join(tmp, "vault") }, args);
    expect(r!.ok).toBe(true);
    expect(r!.message).toBe("code project at " + repo + ": indexed (100 nodes, 10 files)");
    expect(r!.message).not.toContain("note:");
  });

  test("multiple projects + project_path support -> aggregate names every project", () => {
    const repoA = makeRepo(join(tmp, "a-repo"));
    const repoB = makeRepo(join(tmp, "b-repo"));
    makeIndexed(repoA);
    makeIndexed(repoB);
    const r = checkCodegraph(
      { cwd: repoA, vault: join(tmp, "vault"), scanExtraPaths: [repoB] },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        detectProjectPathSupport: () => true,
        runStatusJson: (p: string) => (p === repoA ? okStatus(100, 10) : okStatus(50, 5)),
      },
    );
    expect(r!.ok).toBe(true);
    expect(r!.message).toContain(repoA);
    expect(r!.message).toContain(repoB);
    expect(r!.message).toContain("100 nodes");
    expect(r!.message).toContain("50 nodes");
    expect(r!.message).toContain("2 code projects");
  });

  test("multiple projects + support + one not indexed -> ok false, both named", () => {
    const repoA = makeRepo(join(tmp, "a-repo"));
    const repoB = makeRepo(join(tmp, "b-repo"));
    makeIndexed(repoA);
    // repoB has no .codegraph/ -> not indexed
    const r = checkCodegraph(
      { cwd: repoA, vault: join(tmp, "vault"), scanExtraPaths: [repoB] },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        detectProjectPathSupport: () => true,
        runStatusJson: () => okStatus(100, 10),
      },
    );
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain(repoA);
    expect(r!.message).toContain(repoB);
    expect(r!.message.toLowerCase()).toContain("not indexed");
  });

  test("multiple projects + NO project_path support -> degrade to first project with an explicit note", () => {
    const repoA = makeRepo(join(tmp, "a-repo"));
    const repoB = makeRepo(join(tmp, "b-repo"));
    makeIndexed(repoA);
    makeIndexed(repoB);
    const r = checkCodegraph(
      { cwd: repoA, vault: join(tmp, "vault"), scanExtraPaths: [repoB] },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        detectProjectPathSupport: () => false,
        runStatusJson: () => okStatus(100, 10),
      },
    );
    expect(r!.ok).toBe(true);
    // Degrades to today's single-project (first project) behavior...
    expect(r!.message).toContain(repoA);
    expect(r!.message).toContain("100 nodes");
    // ...plus an explicit note naming the degradation and the project count.
    expect(r!.message).toContain("note:");
    expect(r!.message).toContain("project_path");
    expect(r!.message).toContain("2");
  });

  test("defaultDetectProjectPathSupport returns a boolean without throwing", () => {
    expect(typeof defaultDetectProjectPathSupport()).toBe("boolean");
  });
});
