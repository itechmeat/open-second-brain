/**
 * Idea discovery (Workspace Insight Suite, t_8722a62a): ranked
 * next-direction candidates from open questions, orphan notes, and
 * aging inbox signals.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

test("an artifact whose age cannot be measured says so instead of reading as new", () => {
  // A dangling symlink is enumerated by `readdir` and fails `stat`, which
  // is the portable construction for "exists as a directory entry, cannot
  // be aged". Before B3 both of these read as 0 days old: the signal was
  // then dropped for being under the aging threshold, and the orphan was
  // reported "0d old".
  symlinkSync(join(vault, "Brain", "gone.md"), join(vault, "Brain", "inbox", "sig-broken.md"));
  symlinkSync(join(vault, "Brain", "gone.md"), join(vault, "Brain", "notes", "broken-note.md"));

  const ideas = discoverIdeas(vault, { now: NOW, cap: 20, openQuestions: [] });

  const signal = ideas.find((i) => i.sourceArtifacts[0] === "Brain/inbox/sig-broken.md");
  expect(signal).toBeDefined();
  expect(signal!.reason).toContain("could not be aged");
  expect(signal!.reason).toContain("Brain/inbox/sig-broken.md");

  const orphan = ideas.find((i) => i.title === "broken-note");
  expect(orphan).toBeDefined();
  expect(orphan!.reason).toContain("age unreadable");
  expect(orphan!.reason).not.toContain("0d old");
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
