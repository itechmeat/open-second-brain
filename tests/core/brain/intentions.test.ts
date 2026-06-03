import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listIntentions,
  moveIntentionToHistory,
  setIntention,
  showIntention,
} from "../../../src/core/brain/intentions.ts";

const NOW = new Date("2026-06-03T12:00:00Z");
const LATER = new Date("2026-06-03T13:30:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-intentions-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("setIntention creates a scoped now-document at version 1", () => {
  const chain = setIntention(vault, {
    scope: "feat/agent-surface",
    text: "Ship the surface suite",
    agent: "test-agent",
    now: NOW,
  });
  expect(chain.scope).toBe("feat-agent-surface");
  expect(chain.version).toBe(1);
  expect(chain.path.endsWith(join("Brain", "intentions", "feat-agent-surface.md"))).toBe(true);
  expect(readFileSync(chain.path, "utf8")).toContain("Ship the surface suite");
});

test("updating bumps the version and appends the prior text to history", () => {
  setIntention(vault, { scope: "ws", text: "First intention", agent: "a", now: NOW });
  const chain = setIntention(vault, { scope: "ws", text: "Pivoted plan", agent: "a", now: LATER });
  expect(chain.version).toBe(2);
  const content = readFileSync(chain.path, "utf8");
  expect(content).toContain("Pivoted plan");
  expect(content).toContain("## History");
  expect(content).toContain("v1");
  expect(content).toContain("First intention");
});

test("showIntention returns the current chain and null for unknown scopes", () => {
  setIntention(vault, { scope: "ws", text: "Current work", agent: "a", now: NOW });
  const chain = showIntention(vault, "ws");
  expect(chain?.text).toBe("Current work");
  expect(chain?.version).toBe(1);
  expect(showIntention(vault, "ghost")).toBeNull();
});

test("listIntentions lists active chains sorted by scope", () => {
  setIntention(vault, { scope: "zeta", text: "Z work", agent: "a", now: NOW });
  setIntention(vault, { scope: "alpha", text: "A work", agent: "a", now: NOW });
  const all = listIntentions(vault);
  expect(all.map((c) => c.scope)).toEqual(["alpha", "zeta"]);
});

test("moveIntentionToHistory archives the chain and clears the active file", () => {
  setIntention(vault, { scope: "ws", text: "Done soon", agent: "a", now: NOW });
  const moved = moveIntentionToHistory(vault, { scope: "ws", now: LATER });
  expect(moved.archivePath).toContain(join("Brain", "intentions", "history"));
  expect(existsSync(moved.archivePath)).toBe(true);
  expect(showIntention(vault, "ws")).toBeNull();
  expect(readFileSync(moved.archivePath, "utf8")).toContain("Done soon");
});

test("moving an unknown scope throws a clear error", () => {
  expect(() => moveIntentionToHistory(vault, { scope: "ghost", now: NOW })).toThrow(
    "no active intention",
  );
});

test("archive collisions get a numeric suffix instead of clobbering", () => {
  setIntention(vault, { scope: "ws", text: "First run", agent: "a", now: NOW });
  const first = moveIntentionToHistory(vault, { scope: "ws", now: LATER });
  setIntention(vault, { scope: "ws", text: "Second run", agent: "a", now: LATER });
  const second = moveIntentionToHistory(vault, { scope: "ws", now: LATER });
  expect(second.archivePath).not.toBe(first.archivePath);
  expect(existsSync(first.archivePath)).toBe(true);
  expect(existsSync(second.archivePath)).toBe(true);
});

test("Brain/pinned.md is never touched by intention operations", () => {
  setIntention(vault, { scope: "ws", text: "Work", agent: "a", now: NOW });
  expect(existsSync(join(vault, "Brain", "pinned.md"))).toBe(false);
});
