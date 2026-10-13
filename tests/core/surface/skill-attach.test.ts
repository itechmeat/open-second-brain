import { test, expect } from "bun:test";

import {
  buildSkillAttachment,
  rankSkillCandidates,
  SKILL_USAGE_ORDERING_MAX_BOOST,
} from "../../../src/core/surface/skill-attach.ts";
import type { SkillEntry } from "../../../src/core/surface/skills.ts";

function entry(name: string, description: string, triggers = ""): SkillEntry {
  return Object.freeze({
    name,
    description,
    triggers,
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

test("includeTriggers lets a triggers-only keyword surface a skill", () => {
  const skills = [
    entry("agent-search", "A general capability.", "调研 reconnaissance"),
    entry("brain-memory", "Record taste signals."),
  ];
  // The query word matches only the triggers field, not name or description.
  const without = buildSkillAttachment({ query: "reconnaissance", skills });
  expect(without.items).toHaveLength(0);
  const withTriggers = buildSkillAttachment({
    query: "reconnaissance",
    skills,
    includeTriggers: true,
  });
  expect(withTriggers.items[0]!.name).toBe("agent-search");
});

test("includeTriggers is off by default", () => {
  const skills = [entry("agent-search", "A general capability.", "reconnaissance")];
  expect(buildSkillAttachment({ query: "reconnaissance", skills }).items).toHaveLength(0);
});

test("the block is deterministic and headed", () => {
  const a = buildSkillAttachment({ query: "brain memory signals", skills: SKILLS });
  const b = buildSkillAttachment({ query: "brain memory signals", skills: SKILLS });
  expect(a.block).toBe(b.block);
  expect(a.block.startsWith("## Relevant skills")).toBe(true);
});

// --- usage-ordered ranking (t_5d1ec8a8), gated on a usageWeight input ---

const ORDERING_QUERY = "cut the release notes and publish";
const ORDERING_SKILLS = [
  entry(
    "release-one-off",
    "Cut a software release: bump the version, tag, publish and write notes.",
  ),
  entry("release-daily", "Cut a software release: bump the version, tag and publish."),
  entry("gadget-a", "Repair the workshop gadget."),
  entry("gadget-b", "Repair the workshop gadget."),
  entry("gadget-c", "Repair the workshop gadget."),
  entry("gadget-d", "Repair the workshop gadget."),
];

const DAILY_HEAVY_USAGE = new Map([
  ["release-daily", 1],
  ["release-one-off", 0.05],
]);

function namesOf(items: ReadonlyArray<{ name: string }>): string[] {
  return items.map((i) => i.name);
}

test("the usage boost is capped at one and a half times the lexical score", () => {
  expect(SKILL_USAGE_ORDERING_MAX_BOOST).toBe(0.5);
});

test("with no usage map the order stays the scorer's (off proof)", () => {
  const attachment = buildSkillAttachment({ query: ORDERING_QUERY, skills: ORDERING_SKILLS });
  // Frozen fixture of today's output: the one-off is lexically hotter, the
  // corpus-common gadget helpers never pass the discriminating-term floor.
  expect(namesOf(attachment.items)).toEqual(["release-one-off", "release-daily"]);
  const ranked = rankSkillCandidates({ query: ORDERING_QUERY, skills: ORDERING_SKILLS }, 10);
  const scores = ranked.map((i) => i.score);
  expect(scores).toEqual(scores.toSorted((a, b) => b - a));
});

test("a daily-used skill outranks a lexically hotter one-off under the composite", () => {
  const ranked = rankSkillCandidates(
    { query: ORDERING_QUERY, skills: ORDERING_SKILLS, usageWeight: DAILY_HEAVY_USAGE },
    10,
  );
  expect(namesOf(ranked)).toEqual(["release-daily", "release-one-off"]);
});

test("the returned score stays the lexical score", () => {
  const plain = rankSkillCandidates({ query: ORDERING_QUERY, skills: ORDERING_SKILLS }, 10);
  const ordered = rankSkillCandidates(
    { query: ORDERING_QUERY, skills: ORDERING_SKILLS, usageWeight: DAILY_HEAVY_USAGE },
    10,
  );
  const plainByName = new Map(plain.map((i) => [i.name, i.score]));
  for (const item of ordered) expect(plainByName.get(item.name)).toBe(item.score);
});

test("equal composites resolve by name ascending", () => {
  const twins = [
    entry("skill-bb", "release helper tool"),
    entry("skill-aa", "release helper tool"),
    // Corpus padding so the twins' shared terms stay discriminating (df 2
    // of n 5 passes the floor) and the floor does not drop them outright.
    entry("unrelated-one", "tending the garden plants weekly"),
    entry("unrelated-two", "author schema vocabulary packs"),
  ];
  // Identical descriptors score identically; equal usage keeps the composites
  // equal, so only the name tie-break may order them.
  const ranked = rankSkillCandidates(
    {
      query: "release helper tool",
      skills: twins,
      usageWeight: new Map([
        ["skill-aa", 1],
        ["skill-bb", 1],
      ]),
    },
    10,
  );
  expect(namesOf(ranked)).toEqual(["skill-aa", "skill-bb"]);
});

test("usage can never cross the discriminating-term floor", () => {
  // Every gadget helper matches only corpus-common terms (df > half the
  // corpus), so the floor drops them; a maximal usage weight changes that
  // for none of them.
  const map = new Map([
    ["gadget-a", 1],
    ["gadget-b", 1],
    ["gadget-c", 1],
    ["gadget-d", 1],
  ]);
  const ranked = rankSkillCandidates(
    { query: `${ORDERING_QUERY} gadget`, skills: ORDERING_SKILLS, usageWeight: map },
    10,
  );
  for (const gadget of ["gadget-a", "gadget-b", "gadget-c", "gadget-d"]) {
    expect(namesOf(ranked)).not.toContain(gadget);
  }
});

test("the usage-ordered block is deterministic and re-ids the offer", () => {
  const opts = { query: ORDERING_QUERY, skills: ORDERING_SKILLS, usageWeight: DAILY_HEAVY_USAGE };
  const a = buildSkillAttachment(opts);
  const b = buildSkillAttachment(opts);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(namesOf(a.items)).toEqual(["release-daily", "release-one-off"]);
});

test("an empty usage map is inert: today's order and block", () => {
  const plain = buildSkillAttachment({ query: ORDERING_QUERY, skills: ORDERING_SKILLS });
  const inert = buildSkillAttachment({
    query: ORDERING_QUERY,
    skills: ORDERING_SKILLS,
    usageWeight: new Map(),
  });
  expect(JSON.stringify(inert)).toBe(JSON.stringify(plain));
});
