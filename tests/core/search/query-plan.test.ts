import { test, expect } from "bun:test";
import { buildQueryPlan, NEUTRAL_PROFILE } from "../../../src/core/search/query-plan.ts";

test("an empty query is neutral with the neutral weight profile", () => {
  const plan = buildQueryPlan("   ");
  expect(plan.intent).toBe("neutral");
  expect(plan.weightProfile).toEqual(NEUTRAL_PROFILE);
  expect(plan.expandedTerms).toEqual([]);
  expect(typeof plan.planHash).toBe("string");
  expect(plan.planHash.length).toBeGreaterThan(0);
});

test("a quoted phrase is classified exact and leans keyword over semantic", () => {
  const plan = buildQueryPlan(`the "exact phrase" here`);
  expect(plan.intent).toBe("exact");
  expect(plan.weightProfile.keywordMul).toBeGreaterThan(1);
  expect(plan.weightProfile.semanticMul).toBeLessThan(1);
});

test("a wildcard query is classified exact", () => {
  expect(buildQueryPlan("deploy*").intent).toBe("exact");
});

test("a wikilink-heavy query is classified entity and boosts the entity layer", () => {
  const plan = buildQueryPlan("[[Postgres]] [[Backups]]");
  expect(plan.intent).toBe("entity");
  expect(plan.weightProfile.entityMul).toBeGreaterThan(1);
});

test("a long low-entity natural query is classified broad and leans semantic", () => {
  const plan = buildQueryPlan("how do i configure the deployment process for staging here");
  expect(plan.intent).toBe("broad");
  expect(plan.weightProfile.semanticMul).toBeGreaterThanOrEqual(1);
});

test("a plain short query trips no rule and stays neutral", () => {
  const plan = buildQueryPlan("backup schedule");
  expect(plan.intent).toBe("neutral");
  expect(plan.weightProfile).toEqual(NEUTRAL_PROFILE);
});

test("classification is structural, not lexical: any-script tokens behave the same as latin", () => {
  // Two CJK tokens carry no latin words yet must classify by shape
  // (token count / entity structure), never by a language word list.
  const plan = buildQueryPlan("配置 部署");
  expect(["neutral", "broad", "entity"]).toContain(plan.intent);
  // bounded profile regardless of script
  for (const m of Object.values(plan.weightProfile)) {
    expect(m).toBeGreaterThanOrEqual(0.5);
    expect(m).toBeLessThanOrEqual(1.5);
  }
});

test("is deterministic: identical query yields a deep-equal plan", () => {
  expect(buildQueryPlan("deploy the [[Gateway]]")).toEqual(
    buildQueryPlan("deploy the [[Gateway]]"),
  );
});

test("planHash collapses surrounding/internal whitespace but distinguishes content", () => {
  expect(buildQueryPlan("  backup   schedule  ").planHash).toBe(
    buildQueryPlan("backup schedule").planHash,
  );
  expect(buildQueryPlan("backup schedule").planHash).not.toBe(
    buildQueryPlan("restore schedule").planHash,
  );
});

test("planHash distinguishes queries whose case changes the structural intent", () => {
  // "Backup Schedule" is an entity run; lowercase is not - different
  // intent must yield a different cache key.
  expect(buildQueryPlan("Backup Schedule").planHash).not.toBe(
    buildQueryPlan("backup schedule").planHash,
  );
});
