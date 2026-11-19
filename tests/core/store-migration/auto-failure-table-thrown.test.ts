/**
 * The automatic store migration's failure table, column "stopped by a
 * thrown error": every step boundary of an attempt, one oracle. The rows,
 * the fixture and the oracle are in `fixtures/auto-failure-table.ts`.
 */
import { describe, setDefaultTimeout, test } from "bun:test";

import { ROWS, check, throwAt, useTableFixture } from "./fixtures/auto-failure-table.ts";

// Each case runs up to four attempts; the kill cases spawn a child.
setDefaultTimeout(120_000);

useTableFixture();

describe("an automatic attempt stopped by a thrown error", () => {
  for (const row of ROWS) {
    test(row.name, () => check(() => throwAt(row.step)));
  }
});
