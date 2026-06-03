/**
 * Idea discovery (Workspace Insight Suite, t_8722a62a): ranked
 * next-direction candidates from open questions, orphan notes, and
 * aging inbox signals.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverIdeas, ideaCandidates } from "../../../src/core/brain/idea-discovery.ts";
import { createTriggers } from "../../../src/core/brain/triggers/store.ts";

let vault: string;
const NOW = new Date("2026-06-03T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ideas-"));
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  // hub links to linked-note; orphan-note has no inbound reference.
  writeFileSync(join(vault, "Brain", "notes", "hub.md"), "# Hub\n\nSee [[linked-note]].\n");
  writeFileSync(join(vault, "Brain", "notes", "linked-note.md"), "# Linked\n");
  const orphan = join(vault, "Brain", "notes", "orphan-note.md");
  writeFileSync(orphan, "# Orphan\n\nUnpicked research.\n");
  const past = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000);
  utimesSync(orphan, past, past);
  // One aging signal, one fresh signal.
  const oldSig = join(vault, "Brain", "inbox", "sig-2026-05-01-old-idea.md");
  writeFileSync(oldSig, "---\ntopic: old-idea\n---\n");
  utimesSync(oldSig, past, past);
  writeFileSync(
    join(vault, "Brain", "inbox", "sig-2026-06-02-fresh.md"),
    "---\ntopic: fresh\n---\n",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("ranks open questions above orphans above aging signals", () => {
  const ideas = discoverIdeas(vault, {
    now: NOW,
    openQuestions: [{ topic: "unify-naming", domain: "coding" }],
  });
  expect(ideas.map((i) => i.kind)).toEqual([
    "open_question",
    "orphan_research",
    "orphan_research",
    "idea_direction",
  ]);
  expect(ideas[0]!.title).toBe("unify-naming");
  expect(ideas.some((i) => i.title === "orphan-note")).toBe(true);
  expect(ideas.some((i) => i.title === "old-idea")).toBe(true);
  // The fresh signal and the linked note never surface.
  expect(ideas.some((i) => i.title === "fresh")).toBe(false);
  expect(ideas.some((i) => i.title === "linked-note")).toBe(false);
});

test("cap bounds the ranked list", () => {
  const ideas = discoverIdeas(vault, { now: NOW, cap: 2, openQuestions: [] });
  expect(ideas).toHaveLength(2);
});

test("ideaCandidates convert into enqueueable trigger candidates", () => {
  const ideas = discoverIdeas(vault, { now: NOW, cap: 3, openQuestions: [] });
  const candidates = ideaCandidates(ideas);
  expect(candidates.length).toBe(3);
  const result = createTriggers(vault, candidates, { now: NOW });
  expect(result.created.length).toBe(3);
  // Re-enqueue is blocked by the cooldown keys.
  const again = createTriggers(vault, candidates, { now: NOW });
  expect(again.created).toHaveLength(0);
});
