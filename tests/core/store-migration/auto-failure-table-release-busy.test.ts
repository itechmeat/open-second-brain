/**
 * The automatic store migration's failure table, column "the gate release
 * meets a busy gate lock": at every boundary where the attempt holds the
 * gate, another process holds the gate lock past the release's wait, and
 * the attempt throws there or runs to its end. The gate stays (nothing is
 * opened without the gate lock) and the later starts recover it. The rows,
 * the fixture and the oracle are in `fixtures/auto-failure-table.ts`.
 */
import { describe, setDefaultTimeout, test } from "bun:test";

import {
  GATE_HELD_ROWS,
  check,
  releaseBusyAt,
  useTableFixture,
} from "./fixtures/auto-failure-table.ts";

// Each case spawns two processes and runs up to four attempts.
setDefaultTimeout(120_000);

useTableFixture();

describe("an automatic attempt whose gate release meets a busy gate lock", () => {
  for (const row of GATE_HELD_ROWS) {
    test(`thrown ${row.name}`, async () => {
      await releaseBusyAt(row.step, "throw");
      check(() => {});
    });
  }
  test("the run ended, its release refused", async () => {
    await releaseBusyAt("view-writer", "end");
    check(() => {});
  });
});
