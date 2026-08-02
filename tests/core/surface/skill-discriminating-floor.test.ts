/**
 * Discriminating-term floor for skill attach (Unit J, t_ccb05134).
 *
 * A term carried by most of the descriptor corpus separates nothing: every
 * candidate matches it, so it is evidence for none of them. The floor drops
 * a candidate whose entire match rests on such terms. Discrimination is read
 * from corpus document frequency alone - there is no vocabulary list in the
 * derivation, which is why the same corpus shape behaves identically in a
 * language the repository has never seen.
 */

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
    shadowed: Object.freeze([]),
  });
}

/**
 * Five descriptors sharing one term. "workflow" has df 5 of 5; "quantise"
 * has df 1 of 5. Nothing distinguishes them but the counts.
 */
const CORPUS = [
  entry("alpha", "workflow helper for alpha things"),
  entry("beta", "workflow helper for beta things"),
  entry("gamma", "workflow helper for gamma things"),
  entry("delta", "workflow helper for delta things"),
  entry("epsilon", "workflow quantise tuning helper"),
];

test("a skill matched only on a corpus-common term is dropped", () => {
  const attachment = buildSkillAttachment({
    query: "workflow quantise",
    skills: CORPUS,
    maxSkills: 10,
  });
  expect(attachment.items.map((i) => i.name)).toEqual(["epsilon"]);
});

test("a query of nothing but corpus-common terms offers nothing", () => {
  const attachment = buildSkillAttachment({
    query: "workflow helper",
    skills: CORPUS,
    maxSkills: 10,
  });
  expect(attachment.items).toHaveLength(0);
  expect(attachment.block).toBe("");
  expect(attachment.offerId).toBeNull();
});

test("the floor is document frequency, not a word list: same shape, other language", () => {
  const cyrillic = [
    entry("альфа", "документ для альфа задач"),
    entry("бета", "документ для бета задач"),
    entry("гамма", "документ для гамма задач"),
    entry("дельта", "документ для дельта задач"),
    entry("эпсилон", "документ квантование настройка"),
  ];
  const attachment = buildSkillAttachment({
    query: "документ квантование",
    skills: cyrillic,
    maxSkills: 10,
  });
  expect(attachment.items.map((i) => i.name)).toEqual(["эпсилон"]);
});

test("a term in exactly half the corpus still discriminates", () => {
  const corpus = [
    entry("alpha", "shared marker alpha"),
    entry("beta", "shared marker beta"),
    entry("gamma", "gamma only"),
    entry("delta", "delta only"),
  ];
  const attachment = buildSkillAttachment({
    query: "shared",
    skills: corpus,
    maxSkills: 10,
  });
  expect(attachment.items.map((i) => i.name)).toEqual(["alpha", "beta"]);
});

test("a one-skill corpus carries no discrimination, so the floor abstains", () => {
  // With a single descriptor every term has df = 1 = the whole corpus. A
  // floor that fired here would drop the only answer on no evidence.
  const attachment = buildSkillAttachment({
    query: "configure embedding search",
    skills: [entry("embeddings-setup", "Configure embedding providers for semantic search.")],
  });
  expect(attachment.items.map((i) => i.name)).toEqual(["embeddings-setup"]);
});

test("the floor filters, it never reorders: survivors keep their ranking", () => {
  const attachment = buildSkillAttachment({
    query: "workflow quantise tuning",
    skills: [...CORPUS, entry("zeta", "workflow tuning helper")],
    maxSkills: 10,
  });
  // Both survivors match a discriminating term; the one matching two of
  // them still ranks first, and the four common-only descriptors are gone.
  expect(attachment.items.map((i) => i.name)).toEqual(["epsilon", "zeta"]);
  const scores = attachment.items.map((i) => i.score);
  expect(scores.toSorted((a, b) => b - a)).toEqual(scores);
});
