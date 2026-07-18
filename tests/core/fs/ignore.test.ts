/**
 * P1 (t_9654de80): the path-scope engine mirrors the documented gitignore
 * subset - basename vs anchored matching, directory-only patterns, `**`
 * wildcards, nested composition (deeper file scopes its subtree), nearer-`!`
 * re-include winning over an outer ignore, and `.git/info/exclude` layering at
 * the lowest precedence. Malformed patterns surface as warnings, never silent
 * skips.
 */

import { describe, expect, test } from "bun:test";

import { IgnoreScope, parseIgnoreLayer } from "../../../src/core/fs/ignore.ts";

/** Build a scope from `[baseDir, content]` layers, lowest precedence first. */
function scopeOf(...layers: ReadonlyArray<[string, string]>): IgnoreScope {
  let scope = IgnoreScope.empty();
  for (const [baseDir, content] of layers) {
    scope = scope.extend(
      parseIgnoreLayer(content, baseDir, `${baseDir || "<root>"}/.gitignore`).layer,
    );
  }
  return scope;
}

describe("basename vs anchored matching", () => {
  test("a slashless pattern matches the basename at any depth", () => {
    const scope = scopeOf(["", "*.log\n"]);
    expect(scope.isIgnored("a.log", false)).toBe(true);
    expect(scope.isIgnored("deep/nested/b.log", false)).toBe(true);
    expect(scope.isIgnored("a.logx", false)).toBe(false);
  });

  test("a leading slash anchors to the base directory", () => {
    const scope = scopeOf(["", "/build\n"]);
    expect(scope.isIgnored("build", true)).toBe(true);
    expect(scope.isIgnored("src/build", true)).toBe(false);
  });

  test("an internal slash anchors without a leading slash", () => {
    const scope = scopeOf(["", "src/generated\n"]);
    expect(scope.isIgnored("src/generated", true)).toBe(true);
    expect(scope.isIgnored("pkg/src/generated", true)).toBe(false);
  });
});

describe("directory-only patterns", () => {
  test("a trailing slash matches directories only", () => {
    const scope = scopeOf(["", "dist/\n"]);
    expect(scope.isIgnored("dist", true)).toBe(true);
    expect(scope.isIgnored("dist", false)).toBe(false);
    expect(scope.isIgnored("a/dist", true)).toBe(true);
  });
});

describe("wildcards", () => {
  test("** matches across directory boundaries", () => {
    const scope = scopeOf(["", "logs/**\n"]);
    expect(scope.isIgnored("logs/a.txt", false)).toBe(true);
    expect(scope.isIgnored("logs/x/y.txt", false)).toBe(true);
  });

  test("a/**/b matches zero or more intermediate directories", () => {
    const scope = scopeOf(["", "a/**/b\n"]);
    expect(scope.isIgnored("a/b", true)).toBe(true);
    expect(scope.isIgnored("a/x/b", true)).toBe(true);
    expect(scope.isIgnored("a/x/y/b", true)).toBe(true);
  });

  test("* does not cross a directory boundary", () => {
    const scope = scopeOf(["", "a/*.ts\n"]);
    expect(scope.isIgnored("a/x.ts", false)).toBe(true);
    expect(scope.isIgnored("a/sub/x.ts", false)).toBe(false);
  });
});

describe("nested composition", () => {
  test("a deeper file scopes only its subtree", () => {
    const scope = scopeOf(["", "*.txt\n"], ["sub", "keep-me\n"]);
    // The deeper `keep-me` rule only governs paths under sub/.
    expect(scope.isIgnored("sub/keep-me", false)).toBe(true);
    expect(scope.isIgnored("keep-me", false)).toBe(false);
    // The root rule still applies everywhere.
    expect(scope.isIgnored("top.txt", false)).toBe(true);
  });

  test("a nearer ! re-include wins over an outer ignore", () => {
    const scope = scopeOf(["", "*.env\n"], ["sub", "!prod.env\n"]);
    expect(scope.isIgnored("sub/prod.env", false)).toBe(false);
    expect(scope.isIgnored("sub/dev.env", false)).toBe(true);
    expect(scope.isIgnored("prod.env", false)).toBe(true);
  });
});

describe(".git/info/exclude precedence", () => {
  test("info/exclude sits below .gitignore, so a root ! re-include wins", () => {
    // First layer = info/exclude (lowest), second = root .gitignore (higher).
    const scope = scopeOf(["", "generated\n"], ["", "!generated\n"]);
    expect(scope.isIgnored("generated", true)).toBe(false);
  });
});

describe("comments, blanks, and escapes", () => {
  test("comments and blank lines are ignored", () => {
    const scope = scopeOf(["", "# a comment\n\n*.tmp\n"]);
    expect(scope.isIgnored("x.tmp", false)).toBe(true);
    expect(scope.isIgnored("a comment", false)).toBe(false);
  });

  test("a backslash-escaped hash is a literal filename", () => {
    const scope = scopeOf(["", "\\#literal\n"]);
    expect(scope.isIgnored("#literal", false)).toBe(true);
  });

  test("unescaped trailing whitespace is stripped", () => {
    const scope = scopeOf(["", "foo   \n"]);
    expect(scope.isIgnored("foo", false)).toBe(true);
  });

  test("a backslash-escaped trailing space is retained as a literal filename", () => {
    const scope = scopeOf(["", "foo\\ \n"]);
    // The escaping backslash is consumed; the rule matches `foo ` (with space),
    // not a literal backslash followed by a space.
    expect(scope.isIgnored("foo ", false)).toBe(true);
    expect(scope.isIgnored("foo", false)).toBe(false);
  });
});

describe("malformed patterns", () => {
  test("an unterminated character class is warned, not silently applied", () => {
    const { layer, warnings } = parseIgnoreLayer("good.txt\n[unterminated\n", "", "x/.gitignore");
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.line).toBe(2);
    expect(warnings[0]!.source).toBe("x/.gitignore");
    // The valid rule still compiled; the malformed one produced no rule.
    const scope = IgnoreScope.empty().extend(layer);
    expect(scope.isIgnored("good.txt", false)).toBe(true);
    // The malformed pattern must NOT accidentally ignore anything.
    expect(scope.isIgnored("[unterminated", false)).toBe(false);
    expect(scope.isIgnored("anything", false)).toBe(false);
  });
});

describe("empty scope", () => {
  test("no layers ignores nothing and reports empty", () => {
    const scope = IgnoreScope.empty();
    expect(scope.isEmpty).toBe(true);
    expect(scope.isIgnored("anything/at/all", false)).toBe(false);
  });
});
