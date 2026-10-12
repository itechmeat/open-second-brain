/**
 * Decider envelope and commit validators (recall-quality wave, lane A
 * Task 4): the needs-llm-step envelope builds only when measurable
 * coverage gaps remain, the commit phase refuses malformed shapes,
 * over-limit or oversized sub-queries, unknown evidence ids and
 * replayed round tokens with named typed errors, and an accepted
 * payload drives exactly one further round whose pool grows only by
 * the payload's sub-query pulls.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import {
  DECIDER_SUB_QUERIES_MAX,
  DECIDER_SUB_QUERY_LENGTH_MAX,
  DECIDER_STEP_NAME,
  DECIDER_STEP_RESUME_TARGET,
  DeciderStepError,
  buildDeciderStep,
  commitDeciderStep,
  makeRoundToken,
  nonceRoundToken,
  pauseStateDigest,
} from "../../../src/core/search/decider-step.ts";
import type { CoverageReport } from "../../../src/core/search/coverage.ts";
import { NEEDS_LLM_STEP } from "../../../src/core/brain/llm-step.ts";
import { ResponseShapeError } from "../../../src/core/brain/response-shape.ts";
import {
  ResponseCheckError,
  SEMANTIC_VIOLATION_CODES,
} from "../../../src/core/brain/response-checks.ts";
import { Store } from "../../../src/core/search/store.ts";
import { runFtsQueryDetailed } from "../../../src/core/search/fts.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import {
  runDeciderRound,
  runIterativeRecall,
} from "../../../src/core/search/pipeline/iterative-recall.ts";

/** A measurable, partial coverage with named gaps: the envelope's home case. */
function gappedCoverage(): CoverageReport {
  const term = (t: string, covered: boolean, rare = true) => ({
    term: t,
    df: rare ? 1 : 40,
    idf: rare ? 3.2 : 0.1,
    rare,
    covered,
  });
  return Object.freeze({
    terms: Object.freeze([term("warehouse", true, false), term("chandelier", false)]),
    idfWeightedCoverage: 0.5,
    rareTerms: Object.freeze(["chandelier"]),
    uncoveredRareTerms: Object.freeze(["chandelier"]),
  });
}

/** A complete pool: the envelope must refuse it by name. */
function completeCoverage(): CoverageReport {
  const term = (t: string, covered: boolean, rare = false) => ({
    term: t,
    df: 40,
    idf: 0.1,
    rare,
    covered,
  });
  return Object.freeze({
    terms: Object.freeze([term("warehouse", true), term("rotation", true)]),
    idfWeightedCoverage: 0.95,
    rareTerms: Object.freeze([]),
    uncoveredRareTerms: Object.freeze([]),
  });
}

describe("buildDeciderStep", () => {
  test("builds the needs-llm-step envelope over measurable gaps", () => {
    const poolIds = [3, 7, 11];
    const pause = buildDeciderStep({
      query: "warehouse rotation chandelier",
      round: 3,
      coverage: gappedCoverage(),
      poolIds,
    });
    expect(pause.round).toBe(3);
    expect(pause.llmStep.status).toBe(NEEDS_LLM_STEP);
    expect(pause.llmStep.step).toBe(DECIDER_STEP_NAME);
    expect(pause.llmStep.target_path).toBe(DECIDER_STEP_RESUME_TARGET);
    // The envelope names the gaps and the candidate ids, so the answering
    // agent can select evidence and aim sub-queries without another call.
    expect(pause.llmStep.prompt).toContain("chandelier");
    expect(pause.llmStep.prompt).toContain("3,7,11");
    expect(pause.llmStep.schema_hints.length).toBeGreaterThan(0);
    // The token is opaque and round-stamped.
    expect(pause.token).toBe(makeRoundToken("warehouse rotation chandelier", 3, poolIds));
    expect(pause.token.startsWith("drt-3-")).toBe(true);
  });

  test("refuses a complete pool, an unmeasurable pool and an empty pool by name", () => {
    for (const coverage of [
      completeCoverage(),
      { ...gappedCoverage(), idfWeightedCoverage: null },
    ]) {
      expect(() => buildDeciderStep({ query: "q", round: 2, coverage, poolIds: [1] })).toThrow(
        DeciderStepError,
      );
      try {
        buildDeciderStep({ query: "q", round: 2, coverage, poolIds: [1] });
      } catch (error) {
        expect((error as DeciderStepError).code).toBe("no_gaps");
      }
    }
    expect(() =>
      buildDeciderStep({ query: "q", round: 2, coverage: gappedCoverage(), poolIds: [] }),
    ).toThrow(DeciderStepError);
  });

  test("mints through the registry hook and falls back to the deterministic token", () => {
    const poolIds = [3, 7, 11];
    const mints: Array<{ round: number; pauseDigest: string }> = [];
    const nonceToken = nonceRoundToken(3, "5f1e2d3c4b5a69788796a5b4");
    const pause = buildDeciderStep({
      query: "warehouse rotation chandelier",
      round: 3,
      coverage: gappedCoverage(),
      poolIds,
      mintRoundToken: ({ round, pauseDigest }) => {
        mints.push({ round, pauseDigest });
        return nonceToken;
      },
    });
    // The pause hands out the registry-backed nonce token, and the hook
    // saw the exact pause digest a commit recomputes over this state.
    expect(pause.token).toBe(nonceToken);
    expect(mints).toEqual([
      { round: 3, pauseDigest: pauseStateDigest("warehouse rotation chandelier", 3, poolIds) },
    ]);
    // A mint that could not land (null) falls back to the deterministic
    // digest token, keeping the loop alive without a registry row.
    const fallback = buildDeciderStep({
      query: "warehouse rotation chandelier",
      round: 3,
      coverage: gappedCoverage(),
      poolIds,
      mintRoundToken: () => null,
    });
    expect(fallback.token).toBe(makeRoundToken("warehouse rotation chandelier", 3, poolIds));
    // No hook at all (a commit leg's replay) stays deterministic too.
    const replay = buildDeciderStep({
      query: "warehouse rotation chandelier",
      round: 3,
      coverage: gappedCoverage(),
      poolIds,
    });
    expect(replay.token).toBe(makeRoundToken("warehouse rotation chandelier", 3, poolIds));
  });
});

describe("commitDeciderStep", () => {
  const poolIds = [3, 7, 11];
  const scope = (usedTokens: ReadonlySet<string> = new Set()) => ({
    query: "warehouse rotation chandelier",
    round: 3,
    poolIds,
    usedTokens,
  });
  const token = makeRoundToken("warehouse rotation chandelier", 3, poolIds);
  const payload = { evidence: [3, 7], subQueries: ["chandelier handoff"] };

  test("accepts a well-formed payload and returns the validated commit", () => {
    const commit = commitDeciderStep(token, payload, scope());
    expect(commit.evidenceIds).toEqual([3, 7]);
    expect(commit.subQueries).toEqual(["chandelier handoff"]);
    expect(commit.token).toBe(token);
  });

  test("refuses malformed shapes with the shape error", () => {
    for (const bad of [
      null,
      "nope",
      { evidence: [3] },
      { subQueries: ["q"] },
      { evidence: ["3"], subQueries: ["q"] },
      { evidence: [3], subQueries: ["q"], extra: true },
      { evidence: [3], subQueries: ["  "] },
    ]) {
      expect(() => commitDeciderStep(token, bad, scope())).toThrow(ResponseShapeError);
    }
  });

  test("refuses over-limit and oversized sub-queries with named semantic violations", () => {
    const tooMany = {
      evidence: [3],
      subQueries: Array.from({ length: DECIDER_SUB_QUERIES_MAX + 1 }, (_, i) => `q${i}`),
    };
    try {
      commitDeciderStep(token, tooMany, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseCheckError);
      const violations = (error as ResponseCheckError).violations;
      expect(violations.some((v) => v.code === SEMANTIC_VIOLATION_CODES.threshold)).toBe(true);
    }
    const oversized = { evidence: [3], subQueries: ["q".repeat(DECIDER_SUB_QUERY_LENGTH_MAX + 1)] };
    expect(() => commitDeciderStep(token, oversized, scope())).toThrow(ResponseCheckError);
    // An empty evidence list or an empty sub-query list breaks the
    // payload's cardinality, not just its shape.
    for (const empty of [
      { evidence: [], subQueries: ["q"] },
      { evidence: [3], subQueries: [] },
    ]) {
      expect(() => commitDeciderStep(token, empty, scope())).toThrow(ResponseCheckError);
    }
    // A sub-query whose words are all punctuation carries no
    // significant terms and can never drive a retrieval pull: the
    // validators refuse it before the round spends anything on it.
    const punctuationOnly = { evidence: [3], subQueries: ["---"] };
    try {
      commitDeciderStep(token, punctuationOnly, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseCheckError);
      const violations = (error as ResponseCheckError).violations;
      expect(violations.some((v) => v.code === SEMANTIC_VIOLATION_CODES.threshold)).toBe(true);
    }
    // Duplicate sub-queries are a cross-item refusal.
    const duplicate = { evidence: [3], subQueries: ["chandelier", "chandelier"] };
    try {
      commitDeciderStep(token, duplicate, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseCheckError);
      const violations = (error as ResponseCheckError).violations;
      expect(violations.some((v) => v.code === SEMANTIC_VIOLATION_CODES.crossItem)).toBe(true);
    }
  });

  test("refuses unknown evidence ids by name", () => {
    try {
      commitDeciderStep(token, { evidence: [3, 999999], subQueries: ["q"] }, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DeciderStepError);
      expect((error as DeciderStepError).code).toBe("unknown_evidence");
      expect((error as DeciderStepError).message).toContain("999999");
    }
  });

  test("refuses duplicate evidence ids and selections longer than the pool", () => {
    // A selection naming one chunk twice pins nothing extra: a cross-item
    // refusal, mirroring the duplicate sub-query rule.
    const duplicate = { evidence: [3, 7, 3], subQueries: ["q"] };
    try {
      commitDeciderStep(token, duplicate, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseCheckError);
      const violations = (error as ResponseCheckError).violations;
      expect(violations.some((v) => v.code === SEMANTIC_VIOLATION_CODES.crossItem)).toBe(true);
      expect(
        violations.some((v) => v.path === "$.evidence[2]" && v.message.includes("index 0")),
      ).toBe(true);
    }
    // The evidence budget is the pool itself: the scope's pool holds
    // three candidates, so a four-id selection is refused by name before
    // membership is even checked (the ids are distinct so the registered
    // duplicate rule lets the payload through to the context rule).
    const overPool = { evidence: [1, 2, 5, 8], subQueries: ["q"] };
    try {
      commitDeciderStep(token, overPool, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DeciderStepError);
      expect((error as DeciderStepError).code).toBe("evidence_over_pool");
      expect((error as DeciderStepError).message).toContain("4 id(s)");
    }
  });

  test("refuses a token minted for another state and an already-used token", () => {
    const other = makeRoundToken("warehouse rotation chandelier", 4, poolIds);
    try {
      commitDeciderStep(other, payload, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DeciderStepError).code).toBe("token_mismatch");
    }
    try {
      commitDeciderStep(token, payload, scope(new Set([token])));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DeciderStepError).code).toBe("token_used");
    }
  });

  test("accepts a registry-minted nonce token whose stored digest matches this state", () => {
    // The plan phase minted a nonce token for this exact state: the
    // commit validates the replayed state against the stored digest
    // instead of re-deriving a token.
    const nonceToken = nonceRoundToken(3, "aa1e2d3c4b5a69788796a5b4");
    const stateDigest = pauseStateDigest("warehouse rotation chandelier", 3, poolIds);
    const commit = commitDeciderStep(nonceToken, payload, {
      ...scope(),
      mintedPauseDigest: stateDigest,
    });
    expect(commit.token).toBe(nonceToken);
    expect(commit.evidenceIds).toEqual([3, 7]);
  });

  test("refuses a nonce token whose stored digest names another round or pool", () => {
    const nonceToken = nonceRoundToken(3, "bb1e2d3c4b5a69788796a5b4");
    // The row was minted for a replay that landed elsewhere: genuine
    // divergence, refused by name.
    try {
      commitDeciderStep(nonceToken, payload, {
        ...scope(),
        mintedPauseDigest: pauseStateDigest("warehouse rotation chandelier", 4, poolIds),
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DeciderStepError).code).toBe("token_mismatch");
    }
    // And a nonce token with no registry row behind it at all (expired,
    // swept, or never minted) cannot self-validate.
    try {
      commitDeciderStep(nonceToken, payload, scope());
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DeciderStepError).code).toBe("token_mismatch");
    }
  });
});

describe("runDeciderRound (accepted payload drives round N+1)", () => {
  /**
   * Six common-term docs pin the IDF floor; 60 uniquely-termed relic docs
   * are recoverable; 20 ghost terms live only in the query, so their IDF
   * mass keeps the coverage below the completeness threshold no matter
   * how many relics the loop recovers - the pool still has measurable
   * gaps after the deterministic budget is spent, which is what mints a
   * pause.
   */
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("decider-step"));
  });
  afterEach(() => cleanup());

  async function seed(): Promise<void> {
    for (let i = 1; i <= 6; i++) {
      writeMd(
        vault,
        `Brain/notes/wh${i}.md`,
        `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`,
      );
    }
    for (let i = 1; i <= 60; i++) {
      const term = `relic${String(i).padStart(2, "0")}`;
      writeMd(vault, `Brain/notes/${term}.md`, `# ${term}\n\n${term} provenance record.\n`);
    }
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
  }

  const GHOSTS = Array.from({ length: 20 }, (_, i) => `wyrm${String(i + 1).padStart(2, "0")}`);
  const wideQuery = () =>
    `warehouse rotation ${Array.from({ length: 60 }, (_, i) => `relic${String(i + 1).padStart(2, "0")}`).join(" ")} ${GHOSTS.join(" ")}`;

  test("the loop pauses with a token when gaps survive the deterministic budget", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const loop = runIterativeRecall({
        store,
        query: wideQuery(),
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 1,
        firstRoundNumber: 2,
        isExpired: () => false,
        nowMs: () => 0,
      });
      // Gaps survive the one deterministic round, so the outcome pauses
      // with an envelope and a token instead of pretending completeness.
      expect(loop.stopReason).toBe("round_cap");
      expect(loop.pause).not.toBeNull();
      expect(loop.pause!.round).toBe(3);
      expect(loop.pause!.llmStep.status).toBe(NEEDS_LLM_STEP);
      expect(loop.pause!.token.startsWith("drt-3-")).toBe(true);
      expect(loop.pause!.poolIds.length).toBe(loop.ids.length);
    } finally {
      await store.close();
    }
  });

  test("an accepted payload drives round N+1; the pool grows only by its pulls", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const input = {
        store,
        query: wideQuery(),
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 1,
        firstRoundNumber: 2,
        isExpired: () => false,
        nowMs: () => 0,
      };
      const loop = runIterativeRecall(input);
      const pause = loop.pause;
      expect(pause).not.toBeNull();
      const usedTokens = new Set<string>();
      const before = new Set(loop.ids);
      // A decider payload aimed at one specific relic: the pool may grow
      // by exactly the ids that pull recovers, nothing else.
      const after = runDeciderRound({
        ...input,
        keywordHits: loop.keywordHits,
        chunkIds: new Set(loop.ids),
        pause: pause!,
        token: pause!.token,
        payload: {
          evidence: [pause!.poolIds[0]],
          subQueries: ["relic01 relic02 relic60"],
        },
        usedTokens,
        priorRounds: loop.rounds,
      });
      usedTokens.add(after.token);
      expect(after.round.round).toBe(3);
      expect(after.round.author).toBe("decider");
      expect(after.round.subQueries).toEqual(["relic01 relic02 relic60"]);
      expect(after.stopReason).toBe("decider_round");
      expect(after.token).toBe(pause!.token);
      expect(after.rounds).toHaveLength(loop.rounds.length + 1);
      // The pool grew ONLY by the pull: every new id came from the
      // payload's single sub-query and nothing else was fetched.
      const pulled = runFtsQueryDetailed(store, "relic01", {
        expandedTerms: ["relic02", "relic60"],
        limit: 10,
        pathPrefix: null,
      });
      const expectedNew = new Set(
        pulled.hits.map((h) => h.chunkId).filter((id) => !before.has(id)),
      );
      const gained = after.ids.filter((id) => !before.has(id));
      expect(gained.length).toBe(expectedNew.size);
      for (const id of gained) expect(expectedNew.has(id)).toBe(true);
      expect(after.ids.length).toBe(before.size + expectedNew.size);
      // A replayed commit with the same token is refused: single use.
      expect(() =>
        runDeciderRound({
          ...input,
          keywordHits: loop.keywordHits,
          chunkIds: new Set(loop.ids),
          pause: pause!,
          token: pause!.token,
          payload: { evidence: [pause!.poolIds[0]], subQueries: ["relic01"] },
          usedTokens,
          priorRounds: loop.rounds,
        }),
      ).toThrow(DeciderStepError);
    } finally {
      await store.close();
    }
  });
});
