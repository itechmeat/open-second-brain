/**
 * The automatic store migration's failure table, dimension "what comes
 * next", boundary "the gate taken, the run not on record": the attempt
 * killed after it took the gate and before it saved its state, then each
 * thing that can come through next, one oracle. The rows, the fixture and the
 * oracle are in `fixtures/auto-failure-table.ts`.
 */
import { describe, setDefaultTimeout, test } from "bun:test";

import {
  NEXT_BOUNDARIES,
  NEXT_STEPS,
  checkNext,
  useTableFixture,
} from "./fixtures/auto-failure-table.ts";

// Each case runs up to four attempts; the kill cases spawn a child.
setDefaultTimeout(120_000);

useTableFixture();

const boundary = NEXT_BOUNDARIES.find((b) => b.name === "the gate taken, the run not on record")!;

describe("an automatic attempt stopped by a real kill, then what comes next", () => {
  for (const next of NEXT_STEPS) {
    test(`with ${boundary.name}: ${next.name}`, () => checkNext(boundary.step, next));
  }
});
