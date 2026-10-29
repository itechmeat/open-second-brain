/**
 * The doctor's git tracked-state row (t_206562ae, task B3), against real
 * temporary git repositories - the `sync-exposure.test.ts` shape, with
 * `git init` instead of `.stfolder`.
 *
 * Tracking is measured ONLY by `git ls-files`, never inferred from
 * status: the tracked-and-ignored fixture below is the pin. Ignoring is
 * measured ONLY by `check-ignore` exit discipline. The check is silent
 * when the store is absent, in a non-git folder, or when git cannot
 * answer, and it never edits anything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import {
  GITIGNORE_GUARD_IGNORE_LINE,
  GIT_TRACKED_DERIVED_STATE_CODE,
  gitTrackedStateCheck,
  probeDerivedStoreGitState,
} from "../../../../src/core/brain/doctor/git-tracked-state-check.ts";
import { ensureVaultGitignoreEntries } from "../../../../src/core/brain/gitignore-guard.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-git-tracked-state-"));
  vault = join(tmp, "vault");
  // The Brain layer fixtures the doctor's pass expects, per the
  // secrets-sync fixture shape.
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** `git` in the vault; git is on PATH everywhere this suite runs. */
function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  }
}

/** A real repository around the vault, with its content committed. */
function gitRepoWithCommit(): void {
  git(vault, "init");
  git(vault, "-c", "user.email=o2b@example.com", "-c", "user.name=o2b", "add", "-A");
  git(vault, "-c", "user.email=o2b@example.com", "-c", "user.name=o2b", "commit", "-m", "vault");
}

function withStore(): void {
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
  writeFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "sqlite-bytes", "utf8");
}

function findingsOf(severity: "error" | "warning"): ReadonlyArray<DoctorIssue> {
  const report = runDoctor(vault);
  return (severity === "error" ? report.errors : report.warnings).filter(
    (i) => i.code === GIT_TRACKED_DERIVED_STATE_CODE,
  );
}

describe("the git tracked-state doctor check", () => {
  test("is silent when the vault is not a git worktree", () => {
    withStore();
    expect(findingsOf("error")).toHaveLength(0);
    expect(findingsOf("warning")).toHaveLength(0);
  });

  test("is silent when the derived store directory is absent", () => {
    gitRepoWithCommit();
    expect(findingsOf("error")).toHaveLength(0);
    expect(findingsOf("warning")).toHaveLength(0);
  });

  test("errors when the store is committed, naming the untrack command and the ignore line", () => {
    withStore();
    gitRepoWithCommit();
    const errors = findingsOf("error");
    expect(errors).toHaveLength(1);
    const message = errors[0]!.message;
    expect(message).toContain("git rm -r --cached .open-second-brain/brain.sqlite");
    expect(message).toContain(GITIGNORE_GUARD_IGNORE_LINE);
    expect(message).toContain("never edits");
  });

  test("errors even when the tracked store is ALSO ignored - tracking is measured, not inferred", () => {
    withStore();
    writeFileSync(join(vault, ".gitignore"), `${GITIGNORE_GUARD_IGNORE_LINE}\n`);
    gitRepoWithCommit();
    // The add above had to force nothing: a tracked file under an
    // ignored directory stays in the index, and status would not show
    // it. ls-files must.
    const errors = findingsOf("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
  });

  test("warns (not errors) for a present-but-unignored untracked store", () => {
    withStore();
    gitRepoWithCommit();
    const errors = findingsOf("error");
    expect(errors).toHaveLength(0);
    const warnings = findingsOf("warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(GITIGNORE_GUARD_IGNORE_LINE);
  });

  test("is silent after the full remediation: untrack plus the seeded ignore line", () => {
    withStore();
    gitRepoWithCommit();
    git(
      vault,
      "-c",
      "user.email=o2b@example.com",
      "-c",
      "user.name=o2b",
      "rm",
      "-r",
      "--cached",
      ".open-second-brain/brain.sqlite",
    );
    expect(ensureVaultGitignoreEntries(vault).status).toBe("created");
    git(vault, "-c", "user.email=o2b@example.com", "-c", "user.name=o2b", "add", "-A");
    git(
      vault,
      "-c",
      "user.email=o2b@example.com",
      "-c",
      "user.name=o2b",
      "commit",
      "-m",
      "untrack derived state",
    );
    expect(findingsOf("error")).toHaveLength(0);
    expect(findingsOf("warning")).toHaveLength(0);
  });

  test("is silent in a vault nested in a bigger repo, naming vault-relative paths", () => {
    const nested = join(tmp, "nested");
    vault = join(nested, "vault");
    for (const d of [
      "Brain/preferences",
      "Brain/retired",
      "Brain/inbox",
      "Brain/processed",
      "Brain/log",
    ]) {
      mkdirSync(join(vault, d), { recursive: true });
    }
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
    withStore();
    // The repo root is `tmp`; only the nested vault's store is tracked.
    git(tmp, "init");
    git(tmp, "-c", "user.email=o2b@example.com", "-c", "user.name=o2b", "add", "-A");
    git(tmp, "-c", "user.email=o2b@example.com", "-c", "user.name=o2b", "commit", "-m", "repo");
    const errors = findingsOf("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("git rm -r --cached .open-second-brain/brain.sqlite");
  });

  test("never edits anything", () => {
    withStore();
    gitRepoWithCommit();
    const storeBefore = readFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "utf8");
    runDoctor(vault);
    expect(readFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "utf8")).toBe(
      storeBefore,
    );
    expect(existsSync(join(vault, ".gitignore"))).toBe(false);
  });
});

describe("the probe underneath the check", () => {
  test("a git that cannot answer is silence, not a finding", () => {
    withStore();
    gitRepoWithCommit();
    const savedPath = process.env.PATH;
    try {
      // An empty PATH: execFileSync("git") cannot resolve, every git
      // call in the probe fails, and the probe refuses to guess.
      process.env.PATH = tmp;
      const probe = probeDerivedStoreGitState(vault);
      expect(probe).toBeNull();
      const out = { issues: [] as DoctorIssue[], uncertain: [] };
      expect(() => gitTrackedStateCheck.run(probeContext(), out)).not.toThrow();
      expect(out.issues).toHaveLength(0);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  test("the check is failSoft", () => {
    expect(gitTrackedStateCheck.failSoft).toBe(true);
  });
});

/** A minimal context: the check reads nothing but `vault`. */
function probeContext(): Parameters<typeof gitTrackedStateCheck.run>[0] {
  return {
    vault,
    now: new Date(0),
    config: undefined,
    dbPath: undefined,
    configPath: undefined,
    knownBasenames: new Set(),
    idIndex: new Map(),
    preferences: [],
    logs: [],
  };
}
