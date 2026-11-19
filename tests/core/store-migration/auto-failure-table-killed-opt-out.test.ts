/**
 * The automatic store migration's failure table, column "stopped by a
 * real kill, then the opt-out switched off": every step boundary, one
 * oracle. The rows, the fixture and the oracle are in
 * `fixtures/auto-failure-table.ts`.
 */
import { describe, setDefaultTimeout, test } from "bun:test";

import { ROWS, check, killAt, useTableFixture } from "./fixtures/auto-failure-table.ts";

// Each case runs up to four attempts; the kill cases spawn a child.
setDefaultTimeout(120_000);

useTableFixture();

describe("an automatic attempt stopped by a real kill, then the opt-out switched off", () => {
  for (const row of ROWS) {
    test(row.name, () => check(() => killAt(row.step), { optOutAfter: true }));
  }
});
