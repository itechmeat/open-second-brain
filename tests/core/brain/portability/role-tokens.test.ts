/**
 * Vault-map role-token resolution (Vault portability suite, Feature 3).
 *
 * Resolves `{{role}}` tokens to user content folder names via an optional
 * `Brain/_vault-map.yaml`, falling back to built-in defaults when the file
 * or a token is absent. Mapped values that attempt path traversal are
 * rejected (fall back to the default). The FIXED Brain machinery layout
 * is never routed through this resolver.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ROLE_TOKENS,
  loadVaultMap,
  resolveRoleToken,
  resolveTokens,
} from "../../../../src/core/brain/portability/role-tokens.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vault-map-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function writeMap(body: string): void {
  writeFileSync(join(vault, "Brain", "_vault-map.yaml"), body, "utf8");
}

describe("DEFAULT_ROLE_TOKENS", () => {
  test("covers the canonical PKM roles", () => {
    for (const role of ["inbox", "projects", "areas", "resources", "archive"]) {
      expect(typeof DEFAULT_ROLE_TOKENS[role]!).toBe("string");
    }
  });
});

describe("resolveRoleToken", () => {
  test("returns the default when the map has no override", () => {
    expect(resolveRoleToken({}, "inbox")).toBe(DEFAULT_ROLE_TOKENS["inbox"]!);
  });
  test("returns the override when present", () => {
    expect(resolveRoleToken({ inbox: "Zettelkasten/Inbox" }, "inbox")).toBe(
      "Zettelkasten/Inbox",
    );
  });
  test("strips surrounding braces and whitespace", () => {
    expect(resolveRoleToken({ inbox: "In" }, "{{ inbox }}")).toBe("In");
  });
  test("an unknown token resolves to its literal name", () => {
    expect(resolveRoleToken({}, "{{custom}}")).toBe("custom");
  });
});

describe("resolveTokens", () => {
  test("replaces every token in a string", () => {
    const map = { inbox: "In", projects: "Proj" };
    expect(resolveTokens(map, "{{inbox}}/a and {{projects}}/b")).toBe("In/a and Proj/b");
  });
  test("leaves non-token text untouched", () => {
    expect(resolveTokens({}, "plain/path")).toBe("plain/path");
  });
});

describe("loadVaultMap", () => {
  test("returns built-in defaults when no map file exists", () => {
    const map = loadVaultMap(vault);
    expect(map["inbox"]).toBe(DEFAULT_ROLE_TOKENS["inbox"]!);
  });
  test("merges overrides over defaults", () => {
    writeMap("inbox: Zettelkasten/Inbox\nprojects: Work/Projects\n");
    const map = loadVaultMap(vault);
    expect(map["inbox"]).toBe("Zettelkasten/Inbox");
    expect(map["projects"]).toBe("Work/Projects");
    expect(map["areas"]).toBe(DEFAULT_ROLE_TOKENS["areas"]!);
  });
  test("rejects a traversal value and falls back to the default", () => {
    writeMap("inbox: ../../etc\n");
    expect(loadVaultMap(vault)["inbox"]).toBe(DEFAULT_ROLE_TOKENS["inbox"]!);
  });
  test("rejects an absolute value and falls back to the default", () => {
    writeMap("inbox: /etc/passwd\n");
    expect(loadVaultMap(vault)["inbox"]).toBe(DEFAULT_ROLE_TOKENS["inbox"]!);
  });
  test("allows a folder name containing spaces", () => {
    writeMap("daily-notes: Daily Notes\n");
    expect(loadVaultMap(vault)["daily-notes"]).toBe("Daily Notes");
  });
  test("is deterministic", () => {
    writeMap("inbox: A\n");
    expect(loadVaultMap(vault)).toEqual(loadVaultMap(vault));
  });
});
