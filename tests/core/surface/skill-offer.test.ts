/**
 * Skill offer identity (Unit J, t_ccb05134).
 *
 * An offer is the set of skills `skills_attach` put in front of an agent
 * for one turn. Until it has an identity, a later invocation cannot be
 * joined back to it. The id is content-addressed over the offer itself,
 * so it is reproducible from the offer and needs no offer store.
 */

import { test, expect } from "bun:test";

import { buildSkillAttachment } from "../../../src/core/surface/skill-attach.ts";
import {
  computeSkillOfferId,
  isSkillOfferId,
  readSkillOfferId,
  SKILL_OFFER_ID_KEY,
  SKILL_OFFER_ID_LENGTH,
} from "../../../src/core/surface/skill-offer.ts";
import type { SkillEntry } from "../../../src/core/surface/skills.ts";

const OFFERED = [
  { name: "embeddings-setup", path: "/skills/embeddings-setup" },
  { name: "brain-memory", path: "/skills/brain-memory" },
];

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

test("the same query and offered set mint the same offer id", () => {
  expect(computeSkillOfferId("set up embeddings", OFFERED)).toBe(
    computeSkillOfferId("set up embeddings", OFFERED),
  );
});

test("an offer id is lowercase hex of the declared length", () => {
  const id = computeSkillOfferId("set up embeddings", OFFERED);
  expect(id).toHaveLength(SKILL_OFFER_ID_LENGTH);
  expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  expect(isSkillOfferId(id)).toBe(true);
});

test("a different offered set mints a different offer id", () => {
  const other = [OFFERED[0]!];
  expect(computeSkillOfferId("set up embeddings", other)).not.toBe(
    computeSkillOfferId("set up embeddings", OFFERED),
  );
});

test("rank order is part of the offer, so reordering mints a different id", () => {
  const reversed = OFFERED.toReversed();
  expect(computeSkillOfferId("q", reversed)).not.toBe(computeSkillOfferId("q", OFFERED));
});

test("a different query mints a different offer id", () => {
  expect(computeSkillOfferId("something else", OFFERED)).not.toBe(
    computeSkillOfferId("set up embeddings", OFFERED),
  );
});

test("query whitespace is normalised so trivial reformatting keeps the id", () => {
  expect(computeSkillOfferId("  set up   embeddings\n", OFFERED)).toBe(
    computeSkillOfferId("set up embeddings", OFFERED),
  );
});

test("the same skill name at a different path is a different offer", () => {
  const moved = [{ name: OFFERED[0]!.name, path: "/elsewhere/embeddings-setup" }, OFFERED[1]!];
  expect(computeSkillOfferId("q", moved)).not.toBe(computeSkillOfferId("q", OFFERED));
});

test("isSkillOfferId rejects anything that is not a well-formed id", () => {
  expect(isSkillOfferId(undefined)).toBe(false);
  expect(isSkillOfferId("")).toBe(false);
  expect(isSkillOfferId("not-hex-at-all!!")).toBe(false);
  expect(isSkillOfferId("ABCDEF0123456789")).toBe(false);
  expect(isSkillOfferId("0123456789abcde")).toBe(false);
  expect(isSkillOfferId(1234567890123456)).toBe(false);
});

test("readSkillOfferId lifts a well-formed id from a tool input", () => {
  const id = computeSkillOfferId("set up embeddings", OFFERED);
  expect(readSkillOfferId({ name: "embeddings-setup", [SKILL_OFFER_ID_KEY]: id })).toBe(id);
});

test("readSkillOfferId reports absence and malformation alike as no cited offer", () => {
  expect(readSkillOfferId(undefined)).toBeNull();
  expect(readSkillOfferId({})).toBeNull();
  expect(readSkillOfferId({ [SKILL_OFFER_ID_KEY]: "   " })).toBeNull();
  expect(readSkillOfferId({ [SKILL_OFFER_ID_KEY]: "nope" })).toBeNull();
  expect(readSkillOfferId({ [SKILL_OFFER_ID_KEY]: 42 })).toBeNull();
});

const SKILLS = [
  entry("brain-memory", "Record taste signals and apply-evidence events into the Brain."),
  entry("embeddings-setup", "Configure embedding providers for semantic search."),
  entry("schema-author", "Author Brain schema vocabulary packs."),
];

test("an attachment carries the offer id of exactly what it offered", () => {
  const attachment = buildSkillAttachment({
    query: "configure embedding providers for semantic search",
    skills: SKILLS,
  });
  expect(attachment.items.length).toBeGreaterThan(0);
  expect(attachment.offerId).toBe(
    computeSkillOfferId(
      "configure embedding providers for semantic search",
      attachment.items.map((i) => ({ name: i.name, path: i.path })),
    ),
  );
});

test("the rendered block cites the offer id so an agent can quote it back", () => {
  const attachment = buildSkillAttachment({
    query: "configure embedding providers for semantic search",
    skills: SKILLS,
  });
  expect(attachment.block).toContain(attachment.offerId!);
  expect(attachment.block).toContain(SKILL_OFFER_ID_KEY);
});

test("an empty attachment has no offer id, because nothing was offered", () => {
  const attachment = buildSkillAttachment({ query: "qqq zzz xxyyzz", skills: SKILLS });
  expect(attachment.items).toHaveLength(0);
  expect(attachment.offerId).toBeNull();
  expect(attachment.block).toBe("");
});

test("the offer id covers only the skills that survived the char budget", () => {
  const wide = buildSkillAttachment({
    query: "brain schema memory embedding search signals",
    skills: SKILLS,
  });
  const narrow = buildSkillAttachment({
    query: "brain schema memory embedding search signals",
    skills: SKILLS,
    maxSkills: 1,
  });
  expect(narrow.items).toHaveLength(1);
  expect(narrow.offerId).not.toBe(wide.offerId);
  expect(narrow.offerId).toBe(
    computeSkillOfferId("brain schema memory embedding search signals", [
      { name: narrow.items[0]!.name, path: narrow.items[0]!.path },
    ]),
  );
});
