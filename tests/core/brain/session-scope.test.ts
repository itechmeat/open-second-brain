import { test, expect } from "bun:test";

import { resolveSessionScope, SessionScopeError } from "../../../src/core/brain/session-scope.ts";

test("normalises arbitrary session ids to safe slugs", () => {
  expect(resolveSessionScope("Sess_01 (Claude)")).toBe("sess-01-claude");
  expect(resolveSessionScope("dc6dd88a-dd62-448e-b4d0-e65a2accab69")).toBe(
    "dc6dd88a-dd62-448e-b4d0-e65a2accab69",
  );
  expect(resolveSessionScope("feat/agent-surface")).toBe("feat-agent-surface");
});

test("collapses runs of separators and trims edge dashes", () => {
  expect(resolveSessionScope("a//b__c  d")).toBe("a-b-c-d");
  expect(resolveSessionScope("--edge--")).toBe("edge");
});

test("caps the slug length deterministically", () => {
  const long = "x".repeat(200);
  const scope = resolveSessionScope(long);
  expect(scope.length).toBeLessThanOrEqual(64);
  expect(resolveSessionScope(long)).toBe(scope);
});

test("rejects empty and separator-only input with a typed error", () => {
  expect(() => resolveSessionScope("")).toThrow(SessionScopeError);
  expect(() => resolveSessionScope("   ")).toThrow(SessionScopeError);
  expect(() => resolveSessionScope("///")).toThrow(SessionScopeError);
});

test("is idempotent: a resolved scope resolves to itself", () => {
  const scope = resolveSessionScope("My Workstream #42");
  expect(resolveSessionScope(scope)).toBe(scope);
});
