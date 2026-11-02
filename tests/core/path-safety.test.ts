import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";

import { ensureInsideVault, pathIsInsideOn, vaultRelative } from "../../src/core/path-safety.ts";

// Resolving `/v` produces a platform-appropriate absolute path:
// `/v` on POSIX, `C:\v` (or the current drive) on Windows. Building all
// fixtures off this anchor keeps the assertions portable across both
// without baking POSIX separators into the test inputs.
const VAULT = resolve("/v");
const SIBLING = resolve("/v-evil");
const OUTSIDE = resolve("/etc/passwd");

describe("ensureInsideVault", () => {
  test("accepts the vault root itself", () => {
    expect(ensureInsideVault(VAULT, VAULT)).toBe(VAULT);
  });

  test("accepts descendants", () => {
    const target = join(VAULT, "Notes", "notes", "x.md");
    expect(ensureInsideVault(target, VAULT)).toBe(target);
  });

  test("rejects siblings sharing a name prefix", () => {
    // Without using `path.sep`, the naive `startsWith(vault + "/")` check
    // would happily admit `/v-evil/...` because `/v-evil` starts with `/v`
    // when concatenated. The fixed implementation rejects it.
    expect(() => ensureInsideVault(join(SIBLING, "x.md"), VAULT)).toThrow(/escapes vault/);
  });

  test("rejects paths that resolve outside the vault", () => {
    expect(() => ensureInsideVault(OUTSIDE, VAULT)).toThrow();
    expect(() => ensureInsideVault(join(VAULT, "..", "etc", "passwd"), VAULT)).toThrow();
  });

  test("returns the resolved absolute path", () => {
    const target = join(VAULT, "Notes", "x.md");
    expect(ensureInsideVault(target, VAULT)).toBe(target);
  });
});

describe("ensureInsideVault — realpath / symlink escape", () => {
  // These tests need real on-disk symlinks so realpath() can follow them;
  // the synthetic-path tests above exercise the lexical-only fast path.
  let tmp: string;
  let vault: string;
  let outside: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-path-safety-real-"));
    vault = join(tmp, "vault");
    outside = join(tmp, "outside");
    mkdirSync(vault, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("rejects a target whose ancestor is a symlink to outside the vault", () => {
    // <vault>/escape -> <outside>
    symlinkSync(outside, join(vault, "escape"), "dir");
    const target = join(vault, "escape", "secret.md");
    expect(() => ensureInsideVault(target, vault)).toThrow(/escapes vault via symlink/);
  });

  test("accepts a target inside a real subdirectory", () => {
    const sub = join(vault, "Notes");
    mkdirSync(sub, { recursive: true });
    expect(ensureInsideVault(join(sub, "x.md"), vault)).toBe(join(sub, "x.md"));
  });

  test("accepts a still-non-existent target whose existing ancestor is the vault itself", () => {
    // No symlink involved; just a fresh slug on a real vault. realpath
    // protection should not crash on a path component that doesn't exist
    // yet (the writer creates it after this check passes).
    expect(ensureInsideVault(join(vault, "Notes", "payments", "2026-05-10", "x.md"), vault)).toBe(
      join(vault, "Notes", "payments", "2026-05-10", "x.md"),
    );
  });
});

describe("vaultRelative", () => {
  test("renders descendant paths with forward slashes", () => {
    const target = join(VAULT, "Notes", "notes", "x.md");
    // The renderer always emits forward slashes, even when the host
    // separator is `\`, so wikilinks/Obsidian behave consistently.
    expect(vaultRelative(target, VAULT)).toBe("Notes/notes/x.md");
  });

  test("returns empty string for the vault root itself", () => {
    expect(vaultRelative(VAULT, VAULT)).toBe("");
  });
});

describe("pathIsInsideOn — the win32 rules judged from any host", () => {
  // `path.win32` is pure string work: `resolve` treats `\` and `/` alike
  // as separators, returns a backslash-separated absolute path and
  // collapses `..` lexically, never touching the filesystem - so these
  // judgments run identically on a Linux CI runner. The vault spelling is
  // the shape a Windows runner actually hands over: os.tmpdir() there is
  // the 8.3 short form (TEMP=C:\Users\RUNNER~1\...), and mkdtempSync
  // appends to it verbatim.
  const SHORT_TMP_VAULT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\o2b-fm-cache-inside-ABC";

  test("a `..` rel that lands on a sibling of an 8.3-spelled vault refuses", () => {
    // The spelling a caller holds before any join/resolve folds it: the
    // climb is still lexical, `path.win32.resolve` collapses it, and the
    // collapsed sibling is not inside the vault.
    const raw = `${SHORT_TMP_VAULT}\\..\\o2b-fm-cache-outside-XYZ\\escape.md`;
    expect(win32.resolve(raw)).toBe(
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\o2b-fm-cache-outside-XYZ\\escape.md",
    );
    expect(pathIsInsideOn("win32", raw, SHORT_TMP_VAULT)).toBe(false);
  });

  test("forward slashes fold to separators, so the folded spelling is judged too", () => {
    expect(
      pathIsInsideOn(
        "win32",
        "C:/Users/RUNNER~1/AppData/Local/Temp/o2b-fm-cache-inside-ABC/notes/page.md",
        SHORT_TMP_VAULT,
      ),
    ).toBe(true);
    expect(
      pathIsInsideOn(
        "win32",
        "C:/Users/RUNNER~1/AppData/Local/Temp/o2b-fm-cache-outside-XYZ/escape.md",
        SHORT_TMP_VAULT,
      ),
    ).toBe(false);
  });

  test("the comparison is case-insensitive, as the Windows filesystem names", () => {
    expect(
      pathIsInsideOn(
        "win32",
        "c:\\users\\runner~1\\appdata\\local\\temp\\o2b-fm-cache-inside-abc\\page.md",
        SHORT_TMP_VAULT,
      ),
    ).toBe(true);
  });

  test("a sibling sharing only the vault's name prefix is not inside", () => {
    expect(
      pathIsInsideOn(
        "win32",
        "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\o2b-fm-cache-inside-ABC2\\page.md",
        SHORT_TMP_VAULT,
      ),
    ).toBe(false);
  });
});

describe("pathIsInsideOn — the posix rules stay case-sensitive and slash-separated", () => {
  test("a `..` rel that escapes refuses", () => {
    expect(pathIsInsideOn("posix", "/v/../escape.md", "/v")).toBe(false);
    expect(pathIsInsideOn("posix", "/v/notes/../../escape.md", "/v")).toBe(false);
  });

  test("case differences do not fold on posix", () => {
    expect(pathIsInsideOn("posix", "/V/page.md", "/v")).toBe(false);
  });

  test("a descendant accepts", () => {
    expect(pathIsInsideOn("posix", "/v/notes/page.md", "/v")).toBe(true);
  });
});
