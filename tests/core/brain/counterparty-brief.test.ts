/**
 * The counterparty brief core (dated commitments, t_43b0a379).
 *
 * `buildCounterpartyBrief` answers one question deterministically: given a
 * prompt, an operator-declared trigger vocabulary and a vault, is there
 * exactly one canonical counterparty the prompt names, and if so, what
 * dated, shareable facts does the vault hold about them. Every refusal is
 * an abstention (null); nothing here calls a model or ships a
 * natural-language word list - the triggers are the operator's own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BRIEF_PAGE_READ_CAP,
  DEFAULT_BRIEF_ITEM_LIMIT,
  buildCounterpartyBrief,
  renderCounterpartyBrief,
} from "../../../src/core/brain/counterparty-brief.ts";
import { addPledge } from "../../../src/core/brain/pledges.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";

const NOW = new Date("2026-06-01T12:00:00Z");
const AGENT = "test-agent";
const TRIGGERS = ["meet"] as const;
// The anchoring kernel matches whole name forms, so the prompt carries the
// full name, exactly as a real prompt naming the counterparty would.
const PROMPT = "meet Ada Lovelace to prepare the review";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-counterparty-brief-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Seed one canonical person and return the entity id. */
function seedPerson(name: string, aliases: string[] = [], untrusted = false): string {
  const { entity } = upsertEntity(vault, {
    category: "people",
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    agent: AGENT,
    now: NOW,
    ...(untrusted ? { untrustedOrigin: true } : {}),
  });
  return entity.id;
}

/** A plain vault page (with frontmatter) usable as a pledge's cited source. */
function writeSourcePage(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, ["---", "title: Scratch", "---", "", body].join("\n"));
}

/** A preference page in the vault's preferences directory; returns its rel. */
function writePref(slug: string, body: string, createdAt = "2026-05-01T00:00:00Z"): string {
  const rel = `Brain/preferences/pref-${slug}.md`;
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    [
      "---",
      `id: pref-${slug}`,
      "topic: project notes",
      `principle: ${slug}`,
      "tier: core",
      `created_at: ${createdAt}`,
      "---",
      "",
      body,
    ].join("\n"),
  );
  return rel;
}

/** Add a scalar `visibility:` to an existing page's frontmatter (hand edit). */
function addVisibility(rel: string, token: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  writeFileSync(abs, text.replace(/^---\n/u, `---\nvisibility: ${token}\n`));
}

/** Seed a pledge via the A1 writer, citing a source page that holds the quote. */
function seedPledge(seed: {
  title: string;
  due: string;
  entityId: string;
  sourceRel?: string;
}): string {
  const sourceRel = seed.sourceRel ?? "notes/scratch.md";
  writeSourcePage(sourceRel, "Scratch notes.\n\nThe promise was made in prose here.\n");
  const page = addPledge(vault, {
    title: seed.title,
    due: seed.due,
    source: sourceRel,
    evidence: ["The promise was made in prose here."],
    counterparties: [seed.entityId],
    agent: AGENT,
    now: NOW,
  });
  return `Brain/pledges/${page.slug}.md`;
}

describe("buildCounterpartyBrief abstentions", () => {
  test("an empty trigger list abstains even with a matching entity", () => {
    const id = seedPerson("Ada Lovelace");
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    expect(buildCounterpartyBrief(vault, { text: PROMPT, triggers: [], now: NOW })).toBeNull();
  });

  test("a prompt with no trigger token abstains", () => {
    const id = seedPerson("Ada Lovelace");
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    expect(
      buildCounterpartyBrief(vault, {
        text: "email Ada Lovelace about the review",
        triggers: TRIGGERS,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("the trigger match is deterministic containment over the operator token", () => {
    const id = seedPerson("Ada Lovelace");
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    // "meet" occurs inside "Meeting": containment, no morphology, no list.
    const brief = buildCounterpartyBrief(vault, {
      text: "Meeting with Ada Lovelace tomorrow",
      triggers: TRIGGERS,
      now: NOW,
    });
    expect(brief?.entityId).toBe(id);
  });

  test("zero entity matches abstain", () => {
    seedPerson("Ada Lovelace");
    expect(
      buildCounterpartyBrief(vault, {
        text: "meet Grace Hopper about the engine",
        triggers: TRIGGERS,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("several entity matches abstain (exactly-one rule)", () => {
    seedPerson("Ada Lovelace");
    seedPerson("Grace Hopper");
    expect(
      buildCounterpartyBrief(vault, {
        text: "meet Ada Lovelace and Grace Hopper to plan",
        triggers: TRIGGERS,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("a quarantined entity is no match at all", () => {
    const quarantined = seedPerson("Ada Lovelace", [], true);
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: quarantined });
    expect(
      buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW }),
    ).toBeNull();
  });

  test("an alias anchors the entity", () => {
    const id = seedPerson("Ada Lovelace", ["the Countess"]);
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    const brief = buildCounterpartyBrief(vault, {
      text: "meet the Countess about the engine",
      triggers: TRIGGERS,
      now: NOW,
    });
    expect(brief?.entityId).toBe(id);
  });
});

describe("buildCounterpartyBrief items", () => {
  test("an open pledge surfaces as a dated item naming its source path", () => {
    const id = seedPerson("Ada Lovelace");
    const sourceRel = "notes/scratch.md";
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id, sourceRel });
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief).not.toBeNull();
    expect(brief!.entityName).toBe("Ada Lovelace");
    expect(brief!.items).toHaveLength(1);
    expect(brief!.items[0]!.date).toBe("2026-06-05");
    expect(brief!.items[0]!.sourceRel).toBe(sourceRel);
    expect(brief!.items[0]!.text).toContain("Ship the parser");
  });

  test("a fulfilled pledge never surfaces", () => {
    const id = seedPerson("Ada Lovelace");
    const pledgeRel = seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    // Hand-stamp fulfillment the way fulfillPledge would, keeping this
    // fixture independent of the write path under test elsewhere.
    const abs = join(vault, pledgeRel);
    writeFileSync(abs, readFileSync(abs, "utf8").replace('fulfilled: ""', "fulfilled: 2026-06-02"));
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(0);
    expect(renderCounterpartyBrief(brief!)).toBe("");
  });

  test("at most the item limit surfaces, pledges before preference facts", () => {
    const id = seedPerson("Ada Lovelace");
    seedPledge({ title: "First pledge", due: "2026-06-05", entityId: id });
    seedPledge({
      title: "Second pledge",
      due: "2026-06-07",
      entityId: id,
      sourceRel: "notes/second.md",
    });
    for (let i = 0; i < DEFAULT_BRIEF_ITEM_LIMIT + 2; i++) {
      writePref(`fact-${i}`, "Ada Lovelace reviewed a draft", `2026-05-0${i + 1}T00:00:00Z`);
    }
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(DEFAULT_BRIEF_ITEM_LIMIT);
    expect(brief!.items[0]!.text).toBe("First pledge");
    expect(brief!.items[1]!.text).toBe("Second pledge");
    // Preference facts follow, newest first.
    expect(brief!.items[2]!.sourceRel).toBe("Brain/preferences/pref-fact-4.md");
    // Every item carries a date and a source path.
    for (const item of brief!.items) {
      expect(typeof item.date).toBe("string");
      expect(item.sourceRel.length).toBeGreaterThan(0);
    }
  });

  test("a preference page carrying the reserved token never surfaces", () => {
    seedPerson("Ada Lovelace");
    const kept = writePref("kept", "Ada Lovelace reviewed the draft");
    const hidden = writePref("hidden", "Ada Lovelace shared a confidence", "2026-05-02T00:00:00Z");
    addVisibility(hidden, REMOTE_DENY_VISIBILITY_TOKEN);
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items.map((i) => i.sourceRel)).toEqual([kept]);
  });

  test("a pledge whose cited source carries the reserved token is dropped", () => {
    const id = seedPerson("Ada Lovelace");
    const sourceRel = "notes/private-log.md";
    const pledgeRel = seedPledge({
      title: "Ship the parser",
      due: "2026-06-05",
      entityId: id,
      sourceRel,
    });
    addVisibility(pledgeRel, "team");
    addVisibility(sourceRel, REMOTE_DENY_VISIBILITY_TOKEN);
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(0);
  });

  test("an item drawn from two pages drops when their token intersection is empty", () => {
    const id = seedPerson("Ada Lovelace");
    const sourceRel = "notes/client-notes.md";
    const pledgeRel = seedPledge({
      title: "Ship the parser",
      due: "2026-06-05",
      entityId: id,
      sourceRel,
    });
    addVisibility(pledgeRel, "team");
    addVisibility(sourceRel, "client");
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(0);
  });

  test("an item drawn from two pages sharing a non-reserved token survives", () => {
    const id = seedPerson("Ada Lovelace");
    const sourceRel = "notes/team-notes.md";
    const pledgeRel = seedPledge({
      title: "Ship the parser",
      due: "2026-06-05",
      entityId: id,
      sourceRel,
    });
    addVisibility(pledgeRel, "team");
    addVisibility(sourceRel, "team");
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(1);
  });

  test("a readable predicate removes pages before anything counts them", () => {
    const id = seedPerson("Ada Lovelace");
    const sourceRel = "notes/scratch.md";
    const pledgeRel = seedPledge({
      title: "Ship the parser",
      due: "2026-06-05",
      entityId: id,
      sourceRel,
    });
    const prefRel = writePref("withheld", "Ada Lovelace reviewed the draft");
    // Without the predicate the pledge (named by its cited source) and the
    // preference both count.
    const unfiltered = buildCounterpartyBrief(vault, {
      text: PROMPT,
      triggers: TRIGGERS,
      now: NOW,
    });
    expect(unfiltered!.items.map((i) => i.sourceRel)).toEqual([sourceRel, prefRel]);
    // With it, they contribute nothing and are not counted: the answer is
    // identical to the empty-item brief an empty vault would give.
    const withheld = buildCounterpartyBrief(vault, {
      text: PROMPT,
      triggers: TRIGGERS,
      now: NOW,
      readable: (rel) => rel !== pledgeRel && rel !== prefRel && rel !== sourceRel,
    });
    expect(withheld!.items).toEqual([]);
    expect(renderCounterpartyBrief(withheld!)).toBe("");
  });

  test("the page-read cap bounds the preference walk", () => {
    seedPerson("Ada Lovelace");
    // The cap-sized window by name order carries no anchor; the one
    // anchoring page sorts past it, so a bounded walk never reaches it.
    for (let i = 0; i < BRIEF_PAGE_READ_CAP; i++) {
      writePref(`filler-${String(i).padStart(2, "0")}`, "Nothing about anyone here");
    }
    writePref("zz-anchoring", "Ada Lovelace reviewed the draft");
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(0);
  });

  test("an unparseable preference page contributes nothing and never throws", () => {
    const id = seedPerson("Ada Lovelace");
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    const broken = join(vault, "Brain/preferences", "pref-broken.md");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "no frontmatter here");
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief!.items).toHaveLength(1);
  });
});

describe("renderCounterpartyBrief", () => {
  test("an empty item list renders the empty string", () => {
    seedPerson("Ada Lovelace");
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    expect(brief).not.toBeNull();
    expect(brief!.items).toHaveLength(0);
    expect(renderCounterpartyBrief(brief!)).toBe("");
  });

  test("the render names the entity and each dated item with its source", () => {
    const id = seedPerson("Ada Lovelace");
    seedPledge({ title: "Ship the parser", due: "2026-06-05", entityId: id });
    writePref("kept", "Ada Lovelace reviewed the draft");
    const brief = buildCounterpartyBrief(vault, { text: PROMPT, triggers: TRIGGERS, now: NOW });
    const text = renderCounterpartyBrief(brief!);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("2026-06-05");
    expect(text).toContain("Ship the parser");
    expect(text).toContain("Brain/preferences/pref-kept.md");
  });
});
