import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";

import { ensureInsideVault, vaultRelative } from "../../src/core/path-safety.ts";

describe("ensureInsideVault", () => {
  test("accepts the vault root itself", () => {
    expect(ensureInsideVault("/v", "/v")).toBe("/v");
  });

  test("accepts descendants", () => {
    expect(ensureInsideVault("/v/AI Wiki/notes/x.md", "/v")).toBe(
      "/v/AI Wiki/notes/x.md",
    );
  });

  test("rejects siblings sharing a name prefix", () => {
    // Without using `path.sep`, the naive `startsWith(vault + "/")` check
    // would happily admit `/v-evil/...` because `/v-evil` starts with `/v`
    // when concatenated. The fixed implementation rejects it.
    expect(() => ensureInsideVault("/v-evil/x.md", "/v")).toThrow(/escapes vault/);
  });

  test("rejects paths that resolve outside the vault", () => {
    expect(() => ensureInsideVault("/etc/passwd", "/v")).toThrow();
    expect(() => ensureInsideVault("/v/../etc/passwd", "/v")).toThrow();
  });

  test("returns the resolved absolute path", () => {
    const result = ensureInsideVault("/v/AI Wiki/x.md", "/v");
    expect(result).toBe(join(sep === "\\" ? "\\v" : "/v", "AI Wiki", "x.md"));
  });
});

describe("vaultRelative", () => {
  test("renders descendant paths with forward slashes", () => {
    expect(vaultRelative("/v/AI Wiki/notes/x.md", "/v")).toBe(
      "AI Wiki/notes/x.md",
    );
  });

  test("returns empty string for the vault root itself", () => {
    expect(vaultRelative("/v", "/v")).toBe("");
  });
});
