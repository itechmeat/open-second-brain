/**
 * A recall brief built while the search index is still being built says
 * so: an agent must not read a note missing from it as absent from the
 * vault. The line rides inside the brief's budget, and a brief from a
 * complete index carries none.
 */
import { expect, test } from "bun:test";

import {
  decideRecallInject,
  RECALL_INDEX_BUILDING_LINE,
  type RecallCandidate,
  type RecallResultSet,
  type RecallRetriever,
} from "../../../src/core/brain/recall-inject.ts";
import type { RecallSliceSpec } from "../../../src/core/brain/types.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";

function candidate(path: string): RecallCandidate {
  return {
    path,
    title: `Note ${path}`,
    score: 0.9,
    searchType: "hybrid",
    startLine: 1,
    endLine: 4,
  };
}

function setOf(partial: boolean): RecallResultSet {
  return {
    candidates: [candidate("notes/a.md"), candidate("notes/b.md")],
    total: 2,
    idfWeightedCoverage: 1,
    ...(partial ? { degraded: [RETRIEVAL_DEGRADATION.indexBuilding] } : {}),
  };
}

const retriever =
  (partial: boolean): RecallRetriever =>
  async () =>
    setOf(partial);

test("a brief from an index being built carries the line, one from a complete index none", async () => {
  const building = await decideRecallInject("estuary notes", retriever(true));
  expect(building.kind).toBe("inject");
  if (building.kind !== "inject") return;
  expect(building.brief).toContain(RECALL_INDEX_BUILDING_LINE);
  expect(building.noteCount).toBe(2);
  expect(building.retrievalDegraded).toEqual([RETRIEVAL_DEGRADATION.indexBuilding]);

  const complete = await decideRecallInject("estuary notes", retriever(false));
  expect(complete.kind).toBe("inject");
  if (complete.kind !== "inject") return;
  expect(complete.brief).not.toContain(RECALL_INDEX_BUILDING_LINE);
});

test("the line stays inside the brief's character budget", async () => {
  const maxChars = 400;
  const decision = await decideRecallInject("estuary notes", retriever(true), { maxChars });
  expect(decision.kind).toBe("inject");
  if (decision.kind !== "inject") return;
  expect(decision.brief.length).toBeLessThanOrEqual(maxChars);
  expect(decision.brief).toContain(RECALL_INDEX_BUILDING_LINE);
});

test("a sliced brief carries the line when any slice answered from an index being built", async () => {
  const spec: RecallSliceSpec = {
    name: "all",
    heading: "All",
    pathPrefix: null,
    types: [],
    limit: null,
    maxChars: null,
  };
  const decision = await decideRecallInject("estuary notes", retriever(true), {
    slices: [spec],
    sliceRetriever: () => retriever(true),
  });
  expect(decision.kind).toBe("inject");
  if (decision.kind !== "inject") return;
  expect(decision.brief).toContain(RECALL_INDEX_BUILDING_LINE);
});
