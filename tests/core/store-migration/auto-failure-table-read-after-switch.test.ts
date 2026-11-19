/**
 * The automatic store migration's failure table, column "a read failure
 * after the switch": the attempt stopped at every boundary after the
 * device switched, then the run state failing to read when a later start
 * begins, and (where the switch is left to finish) right after the start
 * finished it. The rows, the fixture and the oracle are in
 * `fixtures/auto-failure-table.ts`.
 */
import { describe, setDefaultTimeout, test } from "bun:test";

import {
  INTERRUPTED_ROWS,
  SWITCHED_ROWS,
  checkReadBackFails,
  checkUnreadableAtStart,
  useTableFixture,
} from "./fixtures/auto-failure-table.ts";

// Each case runs up to five attempts in this process.
setDefaultTimeout(120_000);

useTableFixture();

describe("a read failure after the switch: the run state cannot be read at the start", () => {
  for (const row of SWITCHED_ROWS) {
    test(row.name, () => checkUnreadableAtStart(row.step));
  }
});

describe("a read failure after the switch: the read-back of a finished switch fails", () => {
  for (const row of INTERRUPTED_ROWS) {
    test(row.name, () => checkReadBackFails(row.step));
  }
});
