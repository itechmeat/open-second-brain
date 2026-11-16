/**
 * The neighbour block's caps (task 4.3 item 7): at most five update lines,
 * and the whole body, the cut line included, within 800 characters.
 */

import { expect, test } from "bun:test";

import {
  NEIGHBOUR_CHARS_MAX,
  renderNeighbourBlock,
  type NeighbourCandidate,
} from "../../../src/core/agent-context/neighbours.ts";

function candidate(i: number): NeighbourCandidate {
  return {
    record: `rec-${i}`,
    kind: "decision",
    topic: "01M8RDA9G8QTNMY3CE3GBRYPX1",
    topicTitle: "T",
    text: `decision ${i} `.padEnd(30, "x"),
    seq: 100 - i,
    device: "dev-b",
    agent: "agent-b",
    private: false,
    titlePrivate: false,
  };
}

const cutLine = (n: number): string =>
  n === 0 ? "" : `_${n} more neighbour updates are not shown. ${"y".repeat(100)}_`;

test("the cut line counts toward the character cap", () => {
  const block = renderNeighbourBlock(
    Array.from({ length: 6 }, (_, i) => candidate(i)),
    () => true,
    cutLine,
  );
  const lines = block.body.split("\n");
  const updates = lines.filter((l) => l.startsWith("- "));
  expect(block.body.length).toBeLessThanOrEqual(NEIGHBOUR_CHARS_MAX);
  expect(updates.length).toBeLessThanOrEqual(5);
  expect(block.cutCount).toBe(6 - updates.length);
  expect(lines.at(-1)).toBe(cutLine(block.cutCount));
});

test("gated updates that no line can show are named by the cut line alone", () => {
  // A title longer than the whole block: the update cannot be shown, and
  // the hook moves its watermark past it, so the block must say so.
  const long = { ...candidate(0), topicTitle: "T".repeat(NEIGHBOUR_CHARS_MAX) };
  const block = renderNeighbourBlock([long], () => true, cutLine);
  expect(block.cutCount).toBe(1);
  expect(block.body).toBe(cutLine(1));
});

test("candidates the cap removed are named by the cut line even when none passes the gate", () => {
  // The cap runs before the gate and the watermark moves past them, so
  // an empty body would lose them without a word.
  const block = renderNeighbourBlock([candidate(0)], () => false, cutLine, 3);
  expect(block.body).toBe(cutLine(3));
  expect(block.cutCount).toBe(3);
});

test("no gated update and nothing capped gives an empty body", () => {
  const block = renderNeighbourBlock([candidate(0)], () => false, cutLine, 0);
  expect(block.body).toBe("");
  expect(block.cutCount).toBe(0);
});
