/**
 * Deterministic query expansion producer (link-recall-intelligence,
 * Task 5 / t_2fa95db1): a bare query becomes a structured lex/vec/hyde
 * document for the EXISTING structured-query consumer - no model, no
 * paid call. Lex strips stopwords for the implicit-AND FTS lane, vec
 * adds an entity-context line when registry entities match, hyde is
 * one template passage. Opt-in via `search(config, {expand: true})`.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandQuery } from "../../../src/core/search/query-expansion.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const NOW = new Date("2026-06-05T10:00:00Z");

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-expand-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("expandQuery", () => {
  test("produces deterministic lex/vec/hyde lanes from a bare query", () => {
    const first = expandQuery(vault, "the canary rollout plan");
    const second = expandQuery(vault, "the canary rollout plan");
    expect(first).toEqual(second);
    expect(first.lex.include).toEqual(["canary", "rollout", "plan"]);
    expect(first.lex.exclude).toEqual([]);
    expect(first.vec[0]).toBe("the canary rollout plan");
    expect(first.hyde).toHaveLength(1);
    expect(first.hyde[0]).toContain("canary");
    expect(first.intent).toBeNull();
  });

  test("keeps the raw tokens when every token is a stopword", () => {
    const doc = expandQuery(vault, "the and of");
    expect(doc.lex.include).toEqual(["the", "and", "of"]);
  });

  test("adds one entity-context vec line when a registry entity matches", () => {
    upsertEntity(vault, { name: "Canary Deploy", category: "concept", agent: "tester", now: NOW });
    upsertEntity(vault, {
      name: "Unrelated Thing",
      category: "concept",
      agent: "tester",
      now: NOW,
    });
    const doc = expandQuery(vault, "canary rollout");
    expect(doc.vec).toHaveLength(2);
    expect(doc.vec[1]).toContain("Canary Deploy");
    expect(doc.vec[1]).not.toContain("Unrelated Thing");
    expect(doc.hyde[0]).toContain("Canary Deploy");
  });

  test("caps lex terms and entity context deterministically", () => {
    const long = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
    const doc = expandQuery(vault, long, { maxLexTerms: 5 });
    expect(doc.lex.include).toHaveLength(5);
    expect(doc.lex.include[0]).toBe("term0");
  });

  test("a vault without an entity registry expands without entity context", () => {
    const doc = expandQuery(vault, "canary rollout");
    expect(doc.vec).toEqual(["canary rollout"]);
  });
});

describe("search --expand", () => {
  test("stopword stripping recovers a hit the implicit-AND lane misses", async () => {
    writeFileSync(
      join(vault, "canary.md"),
      "# Canary rollout\n\nShip one instance first, observe, expand gradually.\n",
    );
    writeFileSync(join(vault, "other.md"), "# Other\n\nNothing relevant here at all.\n");
    await indexVault(config);

    const plain = await search(config, { query: "the canary rollout" });
    expect(plain.results).toHaveLength(0);

    const expanded = await search(config, { query: "the canary rollout", expand: true });
    expect(expanded.results.some((r) => r.path === "canary.md")).toBe(true);
    expect(
      expanded.results
        .find((r) => r.path === "canary.md")!
        .reasons.some((reason) => reason.startsWith("lane:lex")),
    ).toBe(true);
  });

  test("an explicit structuredQuery wins over expand", async () => {
    writeFileSync(join(vault, "canary.md"), "# Canary\n\nCanary body.\n");
    writeFileSync(join(vault, "zebra.md"), "# Zebra\n\nZebra body.\n");
    await indexVault(config);
    const outcome = await search(config, {
      query: "canary",
      expand: true,
      structuredQuery: {
        intent: null,
        lex: { include: ["zebra"], exclude: [] },
        vec: [],
        hyde: [],
      },
    });
    expect(outcome.results.some((r) => r.path === "zebra.md")).toBe(true);
    expect(outcome.results.some((r) => r.path === "canary.md")).toBe(false);
  });
});
