import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { ensureInsideVault, vaultRelative } from "../../src/core/path-safety.ts";

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
    const target = join(VAULT, "AI Wiki", "notes", "x.md");
    expect(ensureInsideVault(target, VAULT)).toBe(target);
  });

  test("rejects siblings sharing a name prefix", () => {
    // Without using `path.sep`, the naive `startsWith(vault + "/")` check
    // would happily admit `/v-evil/...` because `/v-evil` starts with `/v`
    // when concatenated. The fixed implementation rejects it.
    expect(() => ensureInsideVault(join(SIBLING, "x.md"), VAULT)).toThrow(
      /escapes vault/,
    );
  });

  test("rejects paths that resolve outside the vault", () => {
    expect(() => ensureInsideVault(OUTSIDE, VAULT)).toThrow();
    expect(() => ensureInsideVault(join(VAULT, "..", "etc", "passwd"), VAULT)).toThrow();
  });

  test("returns the resolved absolute path", () => {
    const target = join(VAULT, "AI Wiki", "x.md");
    expect(ensureInsideVault(target, VAULT)).toBe(target);
  });
});

describe("vaultRelative", () => {
  test("renders descendant paths with forward slashes", () => {
    const target = join(VAULT, "AI Wiki", "notes", "x.md");
    // The renderer always emits forward slashes, even when the host
    // separator is `\`, so wikilinks/Obsidian behave consistently.
    expect(vaultRelative(target, VAULT)).toBe("AI Wiki/notes/x.md");
  });

  test("returns empty string for the vault root itself", () => {
    expect(vaultRelative(VAULT, VAULT)).toBe("");
  });
});
