/**
 * `o2b brain validate` - the standalone validation gate (t_dc782fd5,
 * task C4). Claims pinned here:
 *
 *  1. Selection is exactly one of `--paths` / `--dirty`; neither or both
 *     is a usage error (exit 2), because whole-vault validation stays
 *     doctor's job.
 *  2. Paths mode lints exactly the named set with the write-receipt
 *     page-lint vocabulary: clean exits 0; an error finding exits 1.
 *  3. Warnings are non-blocking by default and block under `--strict`
 *     (exit 2) - byte-for-byte the doctor exit contract.
 *  4. A named page the lint could not read is itself blocking (exit 1):
 *     a gate that could not read what it was pointed at may not report
 *     clean. An over-byte-cap skip is reported and non-blocking.
 *  5. A `--paths` spelling that escapes the vault is refused by name.
 *  6. Dirty mode lints every git-dirty Markdown note - modified, added
 *     and untracked - and ignores dirty non-Markdown files; a vault that
 *     is not a git worktree is a named refusal (exit 2), never a silent
 *     clean pass.
 *  7. The gate is report-only: no `--apply`, no fix vocabulary.
 *  8. The verb is wired: router dispatch, `--help` usage text, manifest
 *     row (so the derived help surfaces list it).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

const CLEAN_PAGE = "---\ntitle: Clean\n---\n\nplain prose\n";
const ERROR_PAGE = "no frontmatter here\n";
const WARNING_PAGE = "---\ntitle: W\n---\n\nsee [[pref-ghost]]\n";

let tmp: string;
let vault: string;
let configPath: string;

function writePage(rel: string, text: string): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return rel;
}

/** Commit the vault's current state, making it a git worktree. */
function gitInit(): void {
  const run = (args: string[]) => execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "base"]);
}

function run(args: ReadonlyArray<string>) {
  return runCli(["brain", "validate", ...args, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-validate-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("selection", () => {
  test("neither selector is a usage error naming the rule", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    const r = await run([]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--paths");
    expect(r.stderr).toContain("--dirty");
  });

  test("both selectors is a usage error", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    const r = await run(["--paths", "Brain/inbox/clean.md", "--dirty"]);
    expect(r.returncode).toBe(2);
  });

  test("a --paths spelling outside the vault is refused by name", async () => {
    const r = await run(["--paths", "../outside.md"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("../outside.md");
  });

  test("an empty --paths list is a usage error", async () => {
    const r = await run(["--paths"]);
    expect(r.returncode).toBe(2);
  });
});

describe("paths mode", () => {
  test("a clean named page exits 0 and says so", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    const r = await run(["--paths", "Brain/inbox/clean.md"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ok");
    expect(r.stdout).toContain("Brain/inbox/clean.md");
  });

  test("an error finding exits 1 and names the page and the code", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    writePage("Brain/inbox/broken.md", ERROR_PAGE);
    // --paths is a repeatable flag (the parser's string-array convention),
    // one flag per page.
    const r = await run(["--paths", "Brain/inbox/clean.md", "--paths", "Brain/inbox/broken.md"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("Brain/inbox/broken.md");
    expect(r.stdout).toContain("frontmatter-missing");
  });

  test("a warning is non-blocking by default and blocks under --strict", async () => {
    writePage("Brain/inbox/warn.md", WARNING_PAGE);
    const loose = await run(["--paths", "Brain/inbox/warn.md"]);
    expect(loose.returncode).toBe(0);
    expect(loose.stdout).toContain("broken-wikilink");
    const strict = await run(["--paths", "Brain/inbox/warn.md", "--strict"]);
    expect(strict.returncode).toBe(2);
    expect(strict.stdout).toContain("broken-wikilink");
  });

  test("an unreadable named page blocks even when nothing else is wrong", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    const r = await run(["--paths", "Brain/inbox/clean.md", "--paths", "Brain/inbox/gone.md"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("Brain/inbox/gone.md");
    expect(r.stdout).toContain("page-unreadable");
  });

  test("--json carries the page-lint report shape and the verdict", async () => {
    writePage("Brain/inbox/warn.md", WARNING_PAGE);
    const r = await run(["--paths", "Brain/inbox/warn.md", "--strict", "--json"]);
    expect(r.returncode).toBe(2);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      selection: string;
      total: number;
      returned: number;
      truncated: boolean;
      findings: Array<{ code: string; page: string; severity: string; next_command?: string }>;
      skipped: Array<{ page: string; reason: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.selection).toBe("paths");
    expect(payload.total).toBe(1);
    expect(payload.truncated).toBe(false);
    expect(payload.findings[0]).toMatchObject({
      code: "broken-wikilink",
      page: "Brain/inbox/warn.md",
      severity: "warning",
    });
    expect(payload.skipped).toEqual([]);
  });

  test("the gate is report-only: --apply is not a flag it knows", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    // Unknown flags raise the parser's CliError, which the brain router
    // reports as `error: unknown flag: --apply` with exit 1 (the repo's
    // one contract for a flag no verb declares).
    const r = await run(["--paths", "Brain/inbox/clean.md", "--apply"]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("unknown flag: --apply");
  });
});

describe("dirty mode", () => {
  test("picks up modified, added and untracked Markdown and ignores non-Markdown", async () => {
    const base = writePage("Brain/inbox/base.md", CLEAN_PAGE);
    gitInit();
    // Modified...
    writePage(base, "---\ntitle: Clean\n---\n\nmore prose\n");
    // ...added (staged)...
    writePage("Brain/inbox/staged.md", CLEAN_PAGE);
    execFileSync("git", ["-C", vault, "add", "Brain/inbox/staged.md"]);
    // ...untracked...
    writePage("Brain/inbox/untracked.md", CLEAN_PAGE);
    // ...and a dirty non-Markdown file that must be ignored.
    writeFileSync(join(vault, "Brain", "scratch.txt"), "not a note\n");

    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Brain/inbox/base.md");
    expect(r.stdout).toContain("Brain/inbox/staged.md");
    expect(r.stdout).toContain("Brain/inbox/untracked.md");
    expect(r.stdout).not.toContain("scratch.txt");
    expect(r.stdout).toContain("3 page");
  });

  test("a dirty error page blocks with exit 1", async () => {
    // A committed base page gives gitInit something to commit; the error
    // page stays untracked, exactly the population --dirty targets.
    writePage("Brain/inbox/base.md", CLEAN_PAGE);
    gitInit();
    writePage("Brain/inbox/untracked.md", ERROR_PAGE);
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("frontmatter-missing");
  });

  test("a vault that is not a git worktree refuses with exit 2, named", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("git");
    expect(r.stdout).not.toContain("ok");
  });

  test("a clean worktree is a clean pass, not an error", async () => {
    writePage("Brain/inbox/clean.md", CLEAN_PAGE);
    gitInit();
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  test("a staged rename lints the destination spelling git reports first", async () => {
    writePage("Brain/inbox/old-name.md", CLEAN_PAGE);
    gitInit();
    // In -z porcelain output a rename's entry carries the DESTINATION
    // and the next NUL field carries the origin - the reverse of the
    // line-oriented `old -> new` spelling. The gate lints the
    // destination, the spelling a commit would contain; the origin is
    // gone from disk and names no page to lint.
    execFileSync("git", ["-C", vault, "mv", "Brain/inbox/old-name.md", "Brain/inbox/new-name.md"]);
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Brain/inbox/new-name.md");
    expect(r.stdout).not.toContain("old-name.md");
    expect(r.stdout).not.toContain("page-unreadable");
  });

  test("a page modified in the index and deleted from the worktree leaves nothing to lint", async () => {
    const page = writePage("Brain/inbox/gone.md", CLEAN_PAGE);
    gitInit();
    // Staged modification, then the worktree copy removed: the X/Y pair
    // is "MD", and the only truthful answer is that no page content a
    // commit would contain exists on disk.
    writePage(page, "---\ntitle: Gone\n---\n\nchanged\n");
    execFileSync("git", ["-C", vault, "add", page]);
    rmSync(join(vault, page));
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("gone.md");
  });

  test("a staged rename whose destination is then deleted leaves nothing to lint", async () => {
    writePage("Brain/inbox/old-name.md", CLEAN_PAGE);
    gitInit();
    // Staged rename, then the destination removed from the worktree: the
    // entry reads "RD", and neither spelling names a page a commit could
    // contain - the origin is gone by the rename, the destination by the
    // removal. Linting the destination spelled a page that is not on
    // disk, and the gate blocked on `page-unreadable`.
    execFileSync("git", ["-C", vault, "mv", "Brain/inbox/old-name.md", "Brain/inbox/new-name.md"]);
    rmSync(join(vault, "Brain", "inbox", "new-name.md"));
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ok");
    expect(r.stdout).not.toContain("page-unreadable");
  });

  test("a vault whose top-level directory name starts with a space still lints its dirt", async () => {
    // The show-prefix is stripped of its trailing newline only: `.trim()`
    // would also strip the leading space of a top-level directory's
    // name, so no repo-relative path would match the prefix and the gate
    // would pass silently over the vault's real dirt.
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, " notes", "Brain", "inbox"), { recursive: true });
    vault = join(repo, " notes");
    writeFileSync(configPath, `vault: ${vault}\n`);
    writePage("Brain/inbox/dirty.md", ERROR_PAGE);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("Brain/inbox/dirty.md");
  });

  test("a vault nested in a larger repository lints only the vault's own dirty pages", async () => {
    // The repo root is tmp, one level above the vault: git reports
    // repo-relative paths, so the gate must rebase them onto the vault
    // and must not inherit dirty Markdown that lives outside it.
    writePage("Brain/inbox/inner.md", CLEAN_PAGE);
    writeFileSync(join(tmp, "outside.md"), CLEAN_PAGE);
    const git = (args: string[]) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    writePage("Brain/inbox/inner.md", ERROR_PAGE);
    writeFileSync(join(tmp, "outside.md"), "no frontmatter here\n");

    const r = await run(["--dirty"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("Brain/inbox/inner.md");
    expect(r.stdout).not.toContain("outside.md");
    expect(r.stdout).not.toContain("page-unreadable");
  });

  test("a vault its enclosing repository ignores refuses, naming --paths as the remedy", async () => {
    // The M14 hole: `rev-parse --is-inside-work-tree` answers true inside
    // an ignored directory and `git status` omits ignored files, so a
    // vault a dotfiles or monorepo checkout ignores read as permanently
    // clean - dirty state git cannot measure, which the gate may never
    // report as a pass. The refusal names the selector that still works.
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "notes", "vault", "Brain", "inbox"), { recursive: true });
    vault = join(repo, "notes", "vault");
    writeFileSync(configPath, `vault: ${vault}\n`);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    writeFileSync(join(repo, ".gitignore"), "notes/\n");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "base"]);
    writePage("Brain/inbox/broken.md", ERROR_PAGE);

    const dirty = await run(["--dirty"]);
    expect(dirty.returncode).toBe(2);
    expect(dirty.stderr).toContain("ignored");
    expect(dirty.stderr).toContain("--paths");

    // The remedy the refusal names still lints the broken note.
    const paths = await run(["--paths", "Brain/inbox/broken.md"]);
    expect(paths.returncode).toBe(1);
    expect(paths.stdout).toContain("frontmatter-missing");
  });
});

describe("wiring", () => {
  test("--help prints the verb's own usage", async () => {
    const r = await runCli(["brain", "validate", "--help"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout.startsWith("usage:")).toBe(true);
    expect(r.stdout).toContain("o2b brain validate");
  });

  test("the manifest carries the verb, so the derived help surfaces list it", async () => {
    const help = await runCli(["help"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
    expect(help.returncode).toBe(0);
    expect(help.stdout).toContain("brain validate");
  });
});
