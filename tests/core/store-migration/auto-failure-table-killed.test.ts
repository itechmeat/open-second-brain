/**
 * The automatic store migration's failure table, column "stopped by a
 * real kill": every step boundary of an attempt, the attempt's child
 * process killed with SIGKILL there, one oracle. The rows, the fixture and
 * the oracle are in `fixtures/auto-failure-table.ts`.
 */
import { describe, setDefaultTimeout, test } from "bun:test";

import { ROWS, check, killAt, useTableFixture } from "./fixtures/auto-failure-table.ts";

// Each case runs up to four attempts; the kill cases spawn a child.
setDefaultTimeout(120_000);

useTableFixture();

describe("an automatic attempt stopped by a real kill", () => {
  for (const row of ROWS) {
    test(row.name, () => check(() => killAt(row.step)));
  }
});
