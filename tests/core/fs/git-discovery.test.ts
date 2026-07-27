/**
 * Unit 1 (t_4b2bd8f7): the shared git-aware discovery module. The hygiene repo
 * scan and the ingest batch planner both compose their ignore layering from
 * these primitives, so the layering order, the base-dir contract and the
 * submodule boundary have exactly one implementation.
 *
 * The module is kernel code: a malformed pattern is RETURNED as a structured
 * warning and never written to a stream.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRepositoryBaseScope,
  extendWithDirectoryIgnore,
  isNestedRepositoryBoundary,
  MAX_IGNORE_FILE_BYTES,
} from "../../../src/core/fs/git-discovery.ts";
import { IgnoreScope } from "../../../src/core/fs/ignore.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-discovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `content` to `<root>/<rel>`, creating parent directories. */
function put(rel: string, content = "x\n"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Run `fn` with stderr captured, returning everything it wrote. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = real;
  }
  return chunks.join("");
}

describe("buildRepositoryBaseScope", () => {
  test("a repository with no ignore files yields an empty scope and no warnings", () => {
    const { scope, warnings } = buildRepositoryBaseScope(root, "");
    expect(scope.isEmpty).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("the root .gitignore governs the whole tree", () => {
    put(".gitignore", "build/\n*.log\n");
    const { scope } = buildRepositoryBaseScope(root, "");
    expect(scope.isIgnored("build", true)).toBe(true);
    expect(scope.isIgnored("src/a.log", false)).toBe(true);
    expect(scope.isIgnored("src/a.ts", false)).toBe(false);
  });

  test(".git/info/exclude is layered BENEATH the root .gitignore", () => {
    put(".git/info/exclude", "secret.md\n");
    put(".gitignore", "!secret.md\n");
    const { scope } = buildRepositoryBaseScope(root, "");
    // The higher-precedence root .gitignore re-includes what the exclude file
    // dropped; the reverse ordering would leave it ignored.
    expect(scope.isIgnored("docs/secret.md", false)).toBe(false);
  });

  test(".git/info/exclude alone still ignores", () => {
    put(".git/info/exclude", "secret.md\n");
    const { scope } = buildRepositoryBaseScope(root, "");
    expect(scope.isIgnored("docs/secret.md", false)).toBe(true);
  });

  test("baseDir places the layers in the caller's path space", () => {
    put(".gitignore", "drop.md\n");
    const { scope } = buildRepositoryBaseScope(root, "sources/repo");
    expect(scope.isIgnored("sources/repo/drop.md", false)).toBe(true);
    // Same basename outside the declared base directory is untouched.
    expect(scope.isIgnored("elsewhere/drop.md", false)).toBe(false);
  });
});

describe("extendWithDirectoryIgnore", () => {
  test("a directory's .gitignore scopes only its own subtree", () => {
    put("pkg/.gitignore", "drop.md\n");
    const { scope } = extendWithDirectoryIgnore(IgnoreScope.empty(), join(root, "pkg"), "pkg");
    expect(scope.isIgnored("pkg/drop.md", false)).toBe(true);
    expect(scope.isIgnored("pkg/deep/drop.md", false)).toBe(true);
    expect(scope.isIgnored("other/drop.md", false)).toBe(false);
  });

  test("a nearer ! re-include wins over the layer beneath it", () => {
    put(".gitignore", "important.md\n");
    put("keep/.gitignore", "!important.md\n");
    const base = buildRepositoryBaseScope(root, "").scope;
    const { scope } = extendWithDirectoryIgnore(base, join(root, "keep"), "keep");
    expect(scope.isIgnored("skip/important.md", false)).toBe(true);
    expect(scope.isIgnored("keep/important.md", false)).toBe(false);
  });

  test("an absent .gitignore leaves the scope's behaviour untouched and warns nothing", () => {
    put(".gitignore", "drop.md\n");
    const base = buildRepositoryBaseScope(root, "").scope;
    const { scope, warnings } = extendWithDirectoryIgnore(base, join(root, "pkg"), "pkg");
    // The directory declares nothing, so the composed scope decides every path
    // exactly as the scope it was built from does.
    expect(scope.isIgnored("pkg/drop.md", false)).toBe(base.isIgnored("pkg/drop.md", false));
    expect(scope.isIgnored("pkg/keep.md", false)).toBe(base.isIgnored("pkg/keep.md", false));
    expect(scope.isEmpty).toBe(base.isEmpty);
    expect(warnings).toEqual([]);
  });
});

describe("an ignore file that cannot be honoured is reported, never swallowed", () => {
  test("an unreadable .gitignore comes back as a structured file-level warning", () => {
    put(".gitignore", "secret.md\n");
    chmodSync(join(root, ".gitignore"), 0o000);
    const { scope, warnings } = buildRepositoryBaseScope(root, "");
    // Nothing was filtered - and the operator is told why.
    expect(scope.isIgnored("secret.md", false)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe(".gitignore");
    expect(warnings[0]!.line).toBe(0);
    expect(warnings[0]!.reason).toContain("EACCES");
  });

  test("an unreadable nested .gitignore names that directory's file", () => {
    put("pkg/.gitignore", "drop.md\n");
    chmodSync(join(root, "pkg", ".gitignore"), 0o000);
    const { warnings } = extendWithDirectoryIgnore(IgnoreScope.empty(), join(root, "pkg"), "pkg");
    expect(warnings.map((w) => w.source)).toEqual(["pkg/.gitignore"]);
  });

  test("a symlinked .gitignore is refused with a warning, never followed", () => {
    put("outside/target.gitignore", "secret.md\n");
    symlinkSync(join(root, "outside", "target.gitignore"), join(root, ".gitignore"));
    const { scope, warnings } = buildRepositoryBaseScope(root, "");
    expect(scope.isIgnored("secret.md", false)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe(".gitignore");
    expect(warnings[0]!.line).toBe(0);
    expect(warnings[0]!.reason).toContain("symbolic link");
  });

  test("an oversized .gitignore is refused with a warning rather than read", () => {
    put(".gitignore", `${"#".repeat(MAX_IGNORE_FILE_BYTES)}\nsecret.md\n`);
    const { scope, warnings } = buildRepositoryBaseScope(root, "");
    expect(scope.isIgnored("secret.md", false)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.reason).toContain(String(MAX_IGNORE_FILE_BYTES));
  });

  test("a .gitignore that is a directory is refused with a warning", () => {
    mkdirSync(join(root, ".gitignore"), { recursive: true });
    const { warnings } = buildRepositoryBaseScope(root, "");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.reason).toContain("regular file");
  });

  test("an absent ignore file is the ordinary case and warns nothing", () => {
    const { warnings } = buildRepositoryBaseScope(root, "");
    expect(warnings).toEqual([]);
  });
});

describe("malformed patterns are returned, never printed", () => {
  test("a malformed root pattern comes back as a structured warning", () => {
    put(".gitignore", "ok.md\n[unterminated\n");
    let warnings: ReturnType<typeof buildRepositoryBaseScope>["warnings"] = [];
    const printed = captureStderr(() => {
      warnings = buildRepositoryBaseScope(root, "").warnings;
    });
    expect(printed).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe(".gitignore");
    expect(warnings[0]!.line).toBe(2);
    expect(warnings[0]!.pattern).toBe("[unterminated");
    expect(warnings[0]!.reason).toContain("unterminated");
  });

  test("a malformed per-directory pattern names that directory's file", () => {
    put("pkg/.gitignore", "[unterminated\n");
    let warnings: ReturnType<typeof extendWithDirectoryIgnore>["warnings"] = [];
    const printed = captureStderr(() => {
      warnings = extendWithDirectoryIgnore(IgnoreScope.empty(), join(root, "pkg"), "pkg").warnings;
    });
    expect(printed).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe("pkg/.gitignore");
  });

  test("a malformed pattern produces no rule, so nothing is silently ignored", () => {
    put(".gitignore", "[unterminated\n");
    const { scope } = buildRepositoryBaseScope(root, "");
    expect(scope.isIgnored("[unterminated", false)).toBe(false);
    expect(scope.isEmpty).toBe(true);
  });
});

describe("isNestedRepositoryBoundary", () => {
  test("a gitlink file marks a submodule boundary", () => {
    put("sub/.git", "gitdir: ../.git/modules/sub\n");
    expect(isNestedRepositoryBoundary(join(root, "sub"))).toBe(true);
  });

  test("a nested .git directory marks a boundary", () => {
    mkdirSync(join(root, "vendor", ".git"), { recursive: true });
    expect(isNestedRepositoryBoundary(join(root, "vendor"))).toBe(true);
  });

  test("an ordinary directory is not a boundary", () => {
    put("plain/a.md");
    expect(isNestedRepositoryBoundary(join(root, "plain"))).toBe(false);
  });

  test("a non-existent directory is not a boundary", () => {
    expect(isNestedRepositoryBoundary(join(root, "missing"))).toBe(false);
  });
});
