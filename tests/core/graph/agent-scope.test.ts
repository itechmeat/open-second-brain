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
  OWNER_UNRESOLVED,
  isOwnerVisible,
  normalizeAgentScope,
  ownerToken,
  pageOwner,
} from "../../../src/core/graph/agent-scope.ts";
import { parseFrontmatterText } from "../../../src/core/vault.ts";

describe("pageOwner", () => {
  test("returns null when no owner is declared", () => {
    expect(pageOwner({})).toBeNull();
  });

  test("normalizes the declared owner token (NFC + lowercase + trim)", () => {
    expect(pageOwner({ owner: "  Agent-A " })).toBe("agent-a");
  });

  /**
   * A present-but-unresolvable `owner:` is an ownership CLAIM, so it must
   * never read as ownerless - that would share an owner-private page with
   * every agent. It resolves to the poison token instead, which no
   * requested scope can equal.
   */
  test("a present-but-unusable owner is unresolved, never ownerless", () => {
    expect(pageOwner({ owner: "" })).toBe(OWNER_UNRESOLVED);
    expect(pageOwner({ owner: 42 })).toBe(OWNER_UNRESOLVED);
    expect(pageOwner({ owner: ["a", "b"] })).toBe(OWNER_UNRESOLVED);
  });

  /**
   * Commit 426d06f8 taught `parseFrontmatterText` to parse block-style
   * YAML lists into arrays, which is how Obsidian Properties writes any
   * list-shaped field. These are the exact shapes it produces.
   */
  test.each([
    ["block sequence", "owner:\n  - agent-a\n  - agent-b"],
    ["inline array", "owner: [agent-a, agent-b]"],
    ["nested mapping", "owner:\n  name: agent-a"],
    ["empty value", "owner:"],
  ])("a %s owner: is unresolved, not shared", (_label, frontmatter) => {
    const [meta] = parseFrontmatterText(`---\n${frontmatter}\n---\nbody\n`);
    expect(pageOwner(meta)).toBe(OWNER_UNRESOLVED);
    expect(isOwnerVisible(pageOwner(meta), "agent-a")).toBe(false);
    expect(isOwnerVisible(pageOwner(meta), "agent-b")).toBe(false);
    // Byte-identical with no scope requested.
    expect(isOwnerVisible(pageOwner(meta), null)).toBe(true);
  });
});

describe("ownerToken", () => {
  test("is idempotent on the poison token", () => {
    expect(ownerToken(OWNER_UNRESOLVED)).toBe(OWNER_UNRESOLVED);
  });

  test("no requested scope can ever equal the poison token", () => {
    // `normalizeAgentScope` lower-cases, so an upper-case token is
    // unreachable from any caller-supplied scope.
    expect(normalizeAgentScope(OWNER_UNRESOLVED)).not.toBe(OWNER_UNRESOLVED);
    expect(isOwnerVisible(OWNER_UNRESOLVED, normalizeAgentScope(OWNER_UNRESOLVED))).toBe(false);
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
