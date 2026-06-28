import { test, expect } from "bun:test";

import { buildSkillAttachment } from "../../../src/core/surface/skill-attach.ts";
import type { SkillEntry } from "../../../src/core/surface/skills.ts";

function entry(name: string, description: string): SkillEntry {
  return Object.freeze({
    name,
    description,
    triggers: "",
    path: `/skills/${name}`,
    skillFile: `/skills/${name}/SKILL.md`,
  });
}

const SKILLS = [
  entry("brain-memory", "Record taste signals and apply-evidence events into the Brain."),
  entry("embeddings-setup", "Configure embedding providers for semantic search."),
  entry("schema-author", "Author Brain schema vocabulary packs."),
];

test("returns the most relevant skills for a turn query", () => {
  const attachment = buildSkillAttachment({
    query: "set up an embedding provider for semantic search",
    skills: SKILLS,
  });
  expect(attachment.items.length).toBeGreaterThan(0);
  expect(attachment.items[0]!.name).toBe("embeddings-setup");
  expect(attachment.block).toContain("embeddings-setup");
});

test("irrelevant query yields an empty attachment", () => {
  const attachment = buildSkillAttachment({ query: "qqq zzz xxyyzz", skills: SKILLS });
  expect(attachment.items).toHaveLength(0);
  expect(attachment.block).toBe("");
});

test("maxSkills caps the attachment size", () => {
  const attachment = buildSkillAttachment({
    query: "brain schema memory embedding search signals",
    skills: SKILLS,
    maxSkills: 1,
  });
  expect(attachment.items).toHaveLength(1);
});

test("maxChars budget drops whole trailing entries, never truncates mid-line", () => {
  const attachment = buildSkillAttachment({
    query: "brain schema memory embedding search signals",
    skills: SKILLS,
    maxChars: 120,
  });
  expect(attachment.block.length).toBeLessThanOrEqual(120);
  for (const item of attachment.items) {
    expect(attachment.block).toContain(item.name);
  }
});

test("empty skill list and empty query fail soft", () => {
  expect(buildSkillAttachment({ query: "anything", skills: [] }).items).toHaveLength(0);
  expect(buildSkillAttachment({ query: "", skills: SKILLS }).items).toHaveLength(0);
});

test("the block is deterministic and headed", () => {
  const a = buildSkillAttachment({ query: "brain memory signals", skills: SKILLS });
  const b = buildSkillAttachment({ query: "brain memory signals", skills: SKILLS });
  expect(a.block).toBe(b.block);
  expect(a.block.startsWith("## Relevant skills")).toBe(true);
});
