/**
 * Entity-contamination check (t_e9692750): a synthesized conclusion
 * must not mention registered entities that appear in none of its
 * cited sources. Pure function over the canonical entity index plus
 * deep-synthesis wiring (matched notes with wikilink citations are
 * checked against the notes they cite).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { upsertEntity } from "../../../../src/core/brain/entities/registry.ts";
import { deepSynthesis } from "../../../../src/core/brain/deep-synthesis.ts";
import {
  checkEntityContamination,
  type ContaminationEntityLike,
} from "../../../../src/core/brain/truth/contamination.ts";
import { indexVault } from "../../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../../../helpers/search-fixtures.ts";

function person(id: string, name: string, aliases: string[] = []): ContaminationEntityLike {
  return { id, name, aliases, status: "active" };
}

describe("checkEntityContamination (pure)", () => {
  const alice = person("ent-people-alice-mason", "Alice Mason", ["Alice"]);
  const bob = person("ent-people-bob-hale", "Bob Hale");

  test("an entity in the conclusion but in no source is a violation", () => {
    const result = checkEntityContamination({
      conclusion: "Alice Mason and Bob Hale both approved the rollout",
      sources: ["Alice Mason approved the rollout yesterday"],
      entities: [alice, bob],
    });
    expect(result.clean).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.entityId).toBe("ent-people-bob-hale");
    expect(result.violations[0]!.name).toBe("Bob Hale");
  });

  test("alias mentions in a source clear the entity", () => {
    const result = checkEntityContamination({
      conclusion: "Alice Mason approved the rollout",
      sources: ["Alice signed off this morning"],
      entities: [alice],
    });
    expect(result.clean).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("unregistered names are never violations", () => {
    const result = checkEntityContamination({
      conclusion: "Zaphod approved the rollout",
      sources: ["Nothing relevant"],
      entities: [alice],
    });
    expect(result.clean).toBe(true);
  });

  test("empty entity registry is always clean", () => {
    const result = checkEntityContamination({
      conclusion: "Alice Mason approved the rollout",
      sources: [],
      entities: [],
    });
    expect(result.clean).toBe(true);
  });

  test("archived entities are ignored", () => {
    const result = checkEntityContamination({
      conclusion: "Bob Hale approved the rollout",
      sources: ["No people here"],
      entities: [{ ...bob, status: "archived" }],
    });
    expect(result.clean).toBe(true);
  });
});

describe("deepSynthesis wiring", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("contamination"));
  });

  afterEach(() => {
    cleanup();
  });

  test("a matched note citing sources that never mention its entities is flagged", async () => {
    const now = new Date("2026-06-01T10:00:00Z");
    upsertEntity(vault, { category: "people", name: "Bob Hale", agent: "tester", now });
    writeMd(
      vault,
      "Brain/notes/conclusion.md",
      "# Conclusion\n\nRollout policy synthesis: Bob Hale approved the canary rollout.\n\n" +
        "[[Brain/notes/source-a.md|source]]\n",
    );
    writeMd(vault, "Brain/notes/source-a.md", "# Source A\n\nThe canary rollout was approved.\n");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config);

    const report = await deepSynthesis(config, "canary rollout", { now });
    expect(report.checked).toContain("entity_contamination");
    expect(report.contaminated.length).toBeGreaterThanOrEqual(1);
    const finding = report.contaminated.find((c) => c.path === "Brain/notes/conclusion.md")!;
    expect(finding.entity).toBe("ent-people-bob-hale");
    expect(finding.sources).toContain("Brain/notes/source-a.md");
  });

  test("with no entity registry the report is byte-identical to today", async () => {
    const now = new Date("2026-06-01T10:00:00Z");
    writeMd(vault, "Brain/notes/plain.md", "# Plain\n\nCanary rollout notes.\n");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config);
    const report = await deepSynthesis(config, "canary rollout", { now });
    expect(report.checked).not.toContain("entity_contamination");
    expect(report.contaminated).toEqual([]);
  });
});
