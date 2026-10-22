/**
 * Registry-aware entity alias expansion (Memory Integrity Suite).
 *
 * Unit level: a query entity matching a registered alias expands to the
 * canonical name forms (and vice versa). End to end: a query naming an
 * ALIAS boosts the document that names the CANONICAL entity, and the
 * result explains the canonical hop in its reasons.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault, search } from "../../../src/core/search/index.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";
import {
  expandQueryEntities,
  PERSON_NICKNAMES_ARTIFACT_REL,
} from "../../../src/core/search/entity-alias.ts";
import { archiveEntity, upsertEntity } from "../../../src/core/brain/entities/registry.ts";

let tmp: ReturnType<typeof createTempVault>;

const NOW = new Date("2026-06-02T12:00:00Z");

beforeEach(() => {
  tmp = createTempVault("entity-alias");
});

afterEach(() => {
  tmp.cleanup();
});

function seedRegistry(): void {
  upsertEntity(tmp.vault, {
    category: "projects",
    name: "Open Second Brain",
    aliases: ["OSB", "the vault project"],
    agent: "claude-dev-agent",
    now: NOW,
  });
}

function seedPerson(name = "Robert Smith"): string {
  const { entity } = upsertEntity(tmp.vault, {
    category: "people",
    name,
    agent: "claude-dev-agent",
    now: NOW,
  });
  return entity.id;
}

/** Write the operator nickname map the config reader resolves. */
function writeNicknames(entries: Record<string, string[]>): void {
  mkdirSync(join(tmp.vault, "Brain", "entities"), { recursive: true });
  writeFileSync(join(tmp.vault, PERSON_NICKNAMES_ARTIFACT_REL), JSON.stringify(entries));
}

describe("expandQueryEntities", () => {
  test("query naming an alias gains the canonical name forms", () => {
    seedRegistry();
    const out = expandQueryEntities(tmp.vault, ["osb"]);
    expect(out.expanded).toContain("osb");
    expect(out.expanded).toContain("open second brain");
    expect(out.added).toContain("open second brain");
    expect(out.sourceIds).toEqual(["ent-projects-open-second-brain"]);
  });

  test("query naming the canonical name gains the alias forms", () => {
    seedRegistry();
    const out = expandQueryEntities(tmp.vault, ["open second brain"]);
    expect(out.added).toContain("osb");
  });

  test("no registry means identity expansion", () => {
    const out = expandQueryEntities(tmp.vault, ["osb"]);
    expect(out.expanded).toEqual(["osb"]);
    expect(out.added).toEqual([]);
    expect(out.sourceIds).toEqual([]);
  });

  test("archived entities do not expand", () => {
    seedRegistry();
    archiveEntity(tmp.vault, { category: "projects", query: "Open Second Brain" }, { now: NOW });
    const out = expandQueryEntities(tmp.vault, ["osb"]);
    expect(out.added).toEqual([]);
  });
});

describe("person-variant expansion", () => {
  test("query 'Bob' resolves against a Robert-only registry through operator nickname data", () => {
    const id = seedPerson();
    writeNicknames({ bob: ["Robert Smith"] });
    const out = expandQueryEntities(tmp.vault, ["bob"]);
    // The declared canonical name joins `added`; the derived structural
    // forms join `derived` ("bob" itself is already a query entity).
    expect(out.expanded).toEqual(["bob", "robert smith", "r smith", "smith robert"]);
    expect(out.added).toEqual(["robert smith"]);
    expect(out.derived).toEqual(["r smith", "smith robert"]);
    expect(out.sourceIds).toEqual([id]);
  });

  test("structural variants participate without any nickname data", () => {
    seedPerson();
    const out = expandQueryEntities(tmp.vault, ["smith robert"]);
    expect(out.added).toEqual(["robert smith"]);
    // The reversed form the query already carried is skipped; the
    // initial form is the one derived addition.
    expect(out.derived).toEqual(["r smith"]);
    expect(out.expanded).toEqual(["smith robert", "robert smith", "r smith"]);
  });

  test("declared forms always win attribution: a derived form another entity declared stays in added", () => {
    seedPerson();
    upsertEntity(tmp.vault, {
      category: "people",
      name: "Smith Robert",
      agent: "claude-dev-agent",
      now: NOW,
    });
    const out = expandQueryEntities(tmp.vault, ["smith robert"]);
    // "smith robert" is entity B's DECLARED name: it must never also
    // appear as a derived form.
    expect(out.added).toContain("robert smith");
    expect(out.derived).not.toContain("smith robert");
    expect(out.sourceIds).toContain("ent-people-smith-robert");
  });

  test("a malformed nickname file drops only the nickname lane: declared expansion keeps working", () => {
    // Identity expansion here would turn off the declared name/alias
    // expansion that never needed the file - one bad operator file must
    // not silence the whole registry.
    seedRegistry();
    mkdirSync(join(tmp.vault, "Brain", "entities"), { recursive: true });
    writeFileSync(join(tmp.vault, PERSON_NICKNAMES_ARTIFACT_REL), "{ not json");
    const out = expandQueryEntities(tmp.vault, ["osb"]);
    expect(out.added).toEqual(["open second brain", "the vault project"]);
    expect(out.expanded).toEqual(["osb", "open second brain", "the vault project"]);
  });

  test("a form two entities share is attributed to the declaration, never to both lanes", () => {
    // Entity A's derivation reaches "smith robert"; entity B DECLARES it
    // as an alias. Whichever entity the walk visits first, the form must
    // land in exactly one lane - the declared one - or candidate signals
    // count it twice and attribute it wrong.
    seedPerson("Robert Smith");
    upsertEntity(tmp.vault, {
      category: "people",
      name: "R Smith",
      aliases: ["Smith Robert"],
      agent: "claude-dev-agent",
      now: NOW,
    });
    const out = expandQueryEntities(tmp.vault, ["r smith"]);
    // The declared claim wins: the shared form is added, not derived.
    expect(out.added).toContain("smith robert");
    expect(out.derived).not.toContain("smith robert");
    // And the lanes are disjoint over the whole expansion.
    expect(new Set(out.expanded).size).toBe(out.expanded.length);
  });

  test("a vault with no person entities returns the identity expansion byte-identically", () => {
    seedRegistry();
    writeNicknames({ bob: ["ada lovelace"] });
    const out = expandQueryEntities(tmp.vault, ["osb"]);
    // Exactly the pre-variant expansion: every declared non-query form
    // in `added`, nothing derived.
    expect(out.expanded).toEqual(["osb", "open second brain", "the vault project"]);
    expect(out.added).toEqual(["open second brain", "the vault project"]);
    expect(out.derived).toEqual([]);
    expect(out.sourceIds).toEqual(["ent-projects-open-second-brain"]);
  });

  test("org-category entities never derive person variants", () => {
    upsertEntity(tmp.vault, {
      category: "org",
      name: "Acme Corp",
      agent: "claude-dev-agent",
      now: NOW,
    });
    const out = expandQueryEntities(tmp.vault, ["corp acme"]);
    expect(out.derived).toEqual([]);
    expect(out.added).toEqual([]);
  });

  test("a quarantined person does not derive", () => {
    upsertEntity(tmp.vault, {
      category: "people",
      name: "Robert Smith",
      agent: "claude-dev-agent",
      now: NOW,
      untrustedOrigin: true,
    });
    writeNicknames({ bob: ["Robert Smith"] });
    const out = expandQueryEntities(tmp.vault, ["bob"]);
    expect(out.expanded).toEqual(["bob"]);
    expect(out.added).toEqual([]);
    expect(out.derived).toEqual([]);
  });

  test("an unreadable or malformed nickname file degrades to the identity expansion", () => {
    seedPerson();
    mkdirSync(join(tmp.vault, "Brain", "entities"), { recursive: true });
    writeFileSync(join(tmp.vault, PERSON_NICKNAMES_ARTIFACT_REL), "{ not json");
    const out = expandQueryEntities(tmp.vault, ["bob"]);
    expect(out.expanded).toEqual(["bob"]);
    expect(out.added).toEqual([]);
    expect(out.derived).toEqual([]);
  });
});

describe("alias-aware search boost", () => {
  test("query naming an alias boosts the doc naming the canonical entity", async () => {
    seedRegistry();
    mkdirSync(join(tmp.vault, "notes"), { recursive: true });
    // Both notes carry identical query-term frequencies and identical
    // word counts so their BM25 scores tie exactly (min-max then maps
    // both to 1.0); entity boost is re-ranking only, never retrieval.
    // Only canonical.md names the CANONICAL entity - without registry
    // expansion both docs would get the same one-entity boost from the
    // literal alias and stay tied.
    writeFileSync(
      join(tmp.vault, "notes", "canonical.md"),
      "---\ntitle: Canonical\n---\n\nThe payment flow OSB runs through Open Second Brain to pay memory costs.\n",
    );
    writeFileSync(
      join(tmp.vault, "notes", "plain.md"),
      "---\ntitle: Plain\n---\n\nThe payment flow OSB runs through other second things to pay memory costs.\n",
    );
    const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
    await indexVault(config, {});

    const out = await search(config, { query: "payment pay memory OSB", limit: 10 });
    const canonical = out.results.findIndex((r) => r.path === "notes/canonical.md");
    const plain = out.results.findIndex((r) => r.path === "notes/plain.md");
    expect(canonical).toBeGreaterThanOrEqual(0);
    expect(plain).toBeGreaterThanOrEqual(0);
    expect(canonical).toBeLessThan(plain);
    const top = out.results[canonical]!;
    expect(top.reasons.some((x) => x.startsWith("entity_match"))).toBe(true);
    expect(top.reasons.some((x) => x.includes("ent-projects-open-second-brain"))).toBe(true);
  });

  test("search without a registry behaves exactly as before", async () => {
    mkdirSync(join(tmp.vault, "notes"), { recursive: true });
    writeFileSync(
      join(tmp.vault, "notes", "a.md"),
      "---\ntitle: A\n---\n\nThe vector flow runs through Vector Store to store vector data.\n",
    );
    const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
    await indexVault(config, {});
    const out = await search(config, { query: "vector Vector Store", limit: 5 });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]!.reasons.some((x) => x.includes("ent-"))).toBe(false);
  });
});
