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
import { expandQueryEntities } from "../../../src/core/search/entity-alias.ts";
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
