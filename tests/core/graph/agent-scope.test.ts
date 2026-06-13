/**
 * Agent-ownership recall isolation (Unit 5 of the Vault Integrity & Trust
 * suite).
 *
 * A page may declare an `owner:` frontmatter token. The recall rule,
 * defined once and consumed by the search filter:
 *   - No `owner:` -> shared, always reachable.
 *   - With `owner:` -> owner-private, reachable only when the caller asks
 *     for that owner's scope.
 *   - No requested scope (the default) -> no filtering at all, so every
 *     vault is byte-identical to today.
 *
 * Owner tokens are opaque, language-neutral identifiers - never a
 * hardcoded natural-language phrase or closed enum.
 */

import { describe, expect, test } from "bun:test";

import {
  isOwnerVisible,
  normalizeAgentScope,
  pageOwner,
} from "../../../src/core/graph/agent-scope.ts";

describe("pageOwner", () => {
  test("returns null when no owner is declared", () => {
    expect(pageOwner({})).toBeNull();
    expect(pageOwner({ owner: "" })).toBeNull();
  });

  test("normalizes the declared owner token (NFC + lowercase + trim)", () => {
    expect(pageOwner({ owner: "  Agent-A " })).toBe("agent-a");
  });

  test("ignores a non-string owner", () => {
    expect(pageOwner({ owner: 42 })).toBeNull();
    expect(pageOwner({ owner: ["a", "b"] })).toBeNull();
  });
});

describe("normalizeAgentScope", () => {
  test("undefined / empty become null (no scope requested)", () => {
    expect(normalizeAgentScope(undefined)).toBeNull();
    expect(normalizeAgentScope("")).toBeNull();
    expect(normalizeAgentScope("   ")).toBeNull();
  });

  test("normalizes a requested scope token", () => {
    expect(normalizeAgentScope(" Agent-A ")).toBe("agent-a");
  });
});

describe("isOwnerVisible", () => {
  test("no requested scope: everything is visible (byte-identical default)", () => {
    expect(isOwnerVisible(null, null)).toBe(true);
    expect(isOwnerVisible("agent-a", null)).toBe(true);
    expect(isOwnerVisible("agent-b", null)).toBe(true);
  });

  test("with a scope: shared (ownerless) pages stay visible", () => {
    expect(isOwnerVisible(null, "agent-a")).toBe(true);
  });

  test("with a scope: an owner-private page is visible only to its owner", () => {
    expect(isOwnerVisible("agent-a", "agent-a")).toBe(true);
    expect(isOwnerVisible("agent-b", "agent-a")).toBe(false);
  });
});
