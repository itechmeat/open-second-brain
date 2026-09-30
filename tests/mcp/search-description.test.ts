/**
 * The `brain_search` when-to-search cue (t_cb1e9d3d): the tool description
 * carries exactly one sentence naming `brain_recall_gate` as the classifier
 * to consult before widening recall - calibration for the agent reading the
 * tool list, nothing more. No fan-out counts and no parallel-search
 * language: the description must not promise machinery it does not have.
 */

import { describe, expect, test } from "bun:test";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";

const SEARCH_DESCRIPTION = SEARCH_TOOLS.find((t) => t.name === "brain_search")!.description;

describe("brain_search when-to-search cue", () => {
  test("the description names brain_recall_gate exactly once", () => {
    expect(SEARCH_DESCRIPTION).toContain("brain_recall_gate");
    expect(SEARCH_DESCRIPTION.split("brain_recall_gate")).toHaveLength(2);
  });

  test("the cue names widening recall, with no fan-out or parallel-search language", () => {
    expect(/widening recall/i.test(SEARCH_DESCRIPTION)).toBe(true);
    expect(/parallel/i.test(SEARCH_DESCRIPTION)).toBe(false);
    expect(/fan-out/i.test(SEARCH_DESCRIPTION)).toBe(false);
    expect(/\d+\s+search(es|es per)/i.test(SEARCH_DESCRIPTION)).toBe(false);
  });
});
