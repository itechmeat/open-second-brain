import { test, expect } from "bun:test";
import { buildQueryPlan, routeSummarySurface } from "../../../src/core/search/query-plan.ts";

// The summary-search router (R1, t_7b96f242) is a deterministic structural
// step layered onto the existing query plan. It NEVER perturbs ranking:
// intent, weightProfile, and planHash are byte-identical whether or not a
// surface vocabulary is supplied. It only adds an advisory `surface` field.

const KINDS = new Set(["summary", "digest", "moc"]);

test("with no surface vocabulary, every query routes to the default surface", () => {
  // The pure, unwired default is provably inert: no vault opts into a
  // vocabulary, so the field can never select the summary surface.
  expect(buildQueryPlan("summary of [[Postgres]]").surface).toBe("default");
  expect(buildQueryPlan("kind:summary").surface).toBe("default");
  expect(buildQueryPlan("source:notes/foo.md").surface).toBe("default");
});

test("an artifact-kind token drawn from the vocabulary selects the summary surface", () => {
  expect(buildQueryPlan("kind:summary Postgres", [], null, KINDS).surface).toBe("summary");
  expect(buildQueryPlan("type:digest weekly", [], null, KINDS).surface).toBe("summary");
});

test("a source-targeted query selects the summary surface", () => {
  expect(buildQueryPlan("source:sources/paper.pdf", [], null, KINDS).surface).toBe("summary");
});

test("an artifact-kind token outside the vocabulary does not select the summary surface", () => {
  expect(buildQueryPlan("kind:invoice Postgres", [], null, KINDS).surface).toBe("default");
});

test("a plain non-summary query stays on the default surface even with a vocabulary", () => {
  expect(buildQueryPlan("how do i configure staging deploys", [], null, KINDS).surface).toBe(
    "default",
  );
  expect(buildQueryPlan("backup schedule", [], null, KINDS).surface).toBe("default");
});

test("surface routing never perturbs the rest of the plan (byte-identical ranking)", () => {
  const withVocab = buildQueryPlan("backup schedule", [], null, KINDS);
  const withoutVocab = buildQueryPlan("backup schedule");
  expect(withVocab.intent).toBe(withoutVocab.intent);
  expect(withVocab.weightProfile).toEqual(withoutVocab.weightProfile);
  expect(withVocab.planHash).toBe(withoutVocab.planHash);
});

test("routeSummarySurface is deterministic and structural (any-script vocabulary token)", () => {
  const cjk = new Set(["要約"]);
  expect(routeSummarySurface("kind:要約 配置", cjk)).toBe("summary");
  expect(routeSummarySurface("kind:要約 配置", cjk)).toBe("summary");
  expect(routeSummarySurface("配置 部署", cjk)).toBe("default");
});

test("an empty vocabulary still honours the vocabulary-independent source signal", () => {
  const empty = new Set<string>();
  expect(routeSummarySurface("source:sources/paper.pdf", empty)).toBe("summary");
  expect(routeSummarySurface("kind:summary", empty)).toBe("default");
});
