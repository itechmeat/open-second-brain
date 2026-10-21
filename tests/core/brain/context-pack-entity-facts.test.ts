/**
 * The conditional `entityFacts` pack section (dated commitments,
 * t_43b0a379): canonical-scope entities anchored from the pack query,
 * each rolling up the ids of candidates the pack already kept whose
 * bodies anchor the entity. Off, every pack is byte-identical - the
 * report member exists only when the caller opted in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";
import { archiveEntity, upsertEntity } from "../../../src/core/brain/entities/registry.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
const AGENT = "test-agent";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pack-entity-facts-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, body: string, createdAt = "2026-05-01T00:00:00Z"): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
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
}

function seedPerson(name: string, aliases: string[] = []): string {
  const { entity } = upsertEntity(vault, {
    category: "people",
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    agent: AGENT,
    now: NOW,
  });
  return entity.id;
}

describe("packContext entityFacts", () => {
  test("the option absent and false both keep the report byte-identical", () => {
    seedPerson("Ada Lovelace");
    writePref("notes", "Pair with Ada Lovelace on the engine");
    const absent = packContext(vault, { maxTokens: 10_000 });
    const off = packContext(vault, { maxTokens: 10_000, entityFacts: false });
    expect(off.entityFacts).toBeUndefined();
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent));
  });

  test("on, ranked mode: entities anchor from the query and roll up kept item ids", () => {
    seedPerson("Ada Lovelace");
    writePref("notes", "Pair with Ada Lovelace on the engine");
    writePref("other", "An unrelated page about caching");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "prepare the meeting with Ada Lovelace",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect(r.entityFacts).toBeDefined();
    expect([...r.entityFacts!.entities]).toEqual([
      {
        entityId: "ent-people-ada-lovelace",
        name: "Ada Lovelace",
        itemIds: ["pref-notes"],
      },
    ]);
  });

  test("an alias anchors the entity too", () => {
    seedPerson("Ada Lovelace", ["the Countess"]);
    writePref("notes", "The Countess reviewed the draft");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "ask the Countess for the review notes",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect(r.entityFacts!.entities.map((e) => e.entityId)).toEqual(["ent-people-ada-lovelace"]);
  });

  test("a body anchors the entity through any of its forms, not only the query's", () => {
    seedPerson("Ada Lovelace", ["the Countess"]);
    // The query names the alias; the kept body names the display name. The
    // rollup asks whether the body anchors the ENTITY, so whichever name
    // the query used must not decide the item ids.
    writePref("notes", "Pair with Ada Lovelace on the engine");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "ask the Countess for the review notes",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect(r.entityFacts!.entities[0]!.itemIds).toEqual(["pref-notes"]);
  });

  test("substring mode: a query that keeps the candidates anchors the same way", () => {
    seedPerson("Grace Hopper");
    // Substring mode filters candidates on topic + principle, so the page
    // names the entity there too and the same query both keeps and rolls
    // it up.
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-grace.md"),
      [
        "---",
        "id: pref-grace",
        "topic: Grace Hopper compiler notes",
        "principle: compilers",
        "tier: core",
        "created_at: 2026-05-01T00:00:00Z",
        "---",
        "",
        "Grace Hopper preferred the compiler notes",
      ].join("\n"),
    );
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Grace Hopper",
      entityFacts: true,
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-grace"]);
    expect(r.entityFacts!.entities.map((e) => e.entityId)).toEqual(["ent-people-grace-hopper"]);
    expect(r.entityFacts!.entities[0]!.itemIds).toEqual(["pref-grace"]);
  });

  test("a quarantined entity never appears", () => {
    upsertEntity(vault, {
      category: "people",
      name: "Quarantined Person",
      agent: AGENT,
      now: NOW,
      untrustedOrigin: true,
    });
    writePref("notes", "Quarantined Person sent a message");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Quarantined Person",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect([...r.entityFacts!.entities]).toEqual([]);
  });

  test("an archived entity never appears", () => {
    const id = seedPerson("Retired Person");
    archiveEntity(vault, { query: "Retired Person" }, { now: NOW });
    writePref("notes", "Retired Person used to own the build");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Retired Person",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect(r.entityFacts!.entities.map((e) => e.entityId)).not.toContain(id);
    expect([...r.entityFacts!.entities]).toEqual([]);
  });

  test("an entity page failing the caller's view is treated as absent", () => {
    const id = seedPerson("Hidden Person");
    writePref("notes", "Hidden Person owns the deploy pipeline");
    const entityPath = join(vault, "Brain", "entities", "people", "ent-people-hidden-person.md");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Hidden Person",
      queryMode: "ranked",
      entityFacts: true,
      visible: (abs) => abs !== entityPath,
    });
    expect(r.entityFacts!.entities.map((e) => e.entityId)).not.toContain(id);
    expect([...r.entityFacts!.entities]).toEqual([]);
  });

  test("item ids draw only from kept candidates", () => {
    seedPerson("Kept Person");
    // Both bodies anchor the entity; the tiny token budget keeps only one.
    writePref("small", "Kept Person likes short notes");
    writePref(
      "large",
      `Kept Person ${"filler prose about nothing in particular ".repeat(60)}`,
      "2026-05-02T00:00:00Z",
    );
    const r = packContext(vault, {
      maxTokens: 60,
      query: "Kept Person",
      queryMode: "ranked",
      entityFacts: true,
    });
    const keptIds = r.items.map((i) => i.id);
    expect(keptIds).toContain("pref-small");
    expect(keptIds).not.toContain("pref-large");
    expect(r.entityFacts!.entities[0]!.itemIds).toEqual(["pref-small"]);
  });

  test("the section respects the view the items respect", () => {
    seedPerson("Withheld Person");
    writePref("notes", "Withheld Person runs the oncall rotation");
    const withheld = join(vault, "Brain", "preferences", "pref-notes.md");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Withheld Person",
      queryMode: "ranked",
      entityFacts: true,
      visible: (abs) => abs !== withheld,
    });
    expect(r.items.map((i) => i.id)).toEqual([]);
    expect([...r.entityFacts!.entities]).toEqual([
      { entityId: "ent-people-withheld-person", name: "Withheld Person", itemIds: [] },
    ]);
  });

  test("an anchored entity with no kept item still lists, with empty item ids", () => {
    seedPerson("Solo Person");
    writePref("notes", "Nothing about anyone relevant here");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Solo Person",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect([...r.entityFacts!.entities]).toEqual([
      { entityId: "ent-people-solo-person", name: "Solo Person", itemIds: [] },
    ]);
  });

  test("at most three entities anchor, deterministically by entity id", () => {
    seedPerson("Aaa Person");
    seedPerson("Bbb Person");
    seedPerson("Ccc Person");
    seedPerson("Ddd Person");
    writePref("notes", "Aaa Person Bbb Person Ccc Person Ddd Person in one page");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "Aaa Person Bbb Person Ccc Person Ddd Person",
      queryMode: "ranked",
      entityFacts: true,
    });
    expect(r.entityFacts!.entities.map((e) => e.entityId)).toEqual([
      "ent-people-aaa-person",
      "ent-people-bbb-person",
      "ent-people-ccc-person",
    ]);
  });

  test("a pack without a query anchors nothing", () => {
    seedPerson("Ada Lovelace");
    writePref("notes", "Pair with Ada Lovelace on the engine");
    const r = packContext(vault, { maxTokens: 10_000, entityFacts: true });
    expect([...r.entityFacts!.entities]).toEqual([]);
  });

  test("a broken entity store leaves the pack answered, with an empty rollup", () => {
    seedPerson("Ada Lovelace");
    writePref("notes", "Pair with Ada Lovelace on the engine");
    // The entity store stops being a directory, so the index build throws
    // where the rollup reads it.
    rmSync(join(vault, "Brain", "entities"), { recursive: true, force: true });
    writeFileSync(join(vault, "Brain", "entities"), "not a directory\n");
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "prepare the meeting with Ada Lovelace",
      queryMode: "ranked",
      entityFacts: true,
    });
    // The rollup is an OPTIONAL section, so a broken entity store must not
    // fail the pack: the pack still answers, and the section is present
    // and empty.
    expect(r.entityFacts).toBeDefined();
    expect([...r.entityFacts!.entities]).toEqual([]);
    expect(r.items.map((i) => i.id)).toEqual(["pref-notes"]);
  });
});
