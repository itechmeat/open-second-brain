/**
 * The coarse rule of the write census (change
 * `lane-private-partition-reach`), for rows not traced one by one in the
 * fourth closure round.
 *
 * Bulk form: a verb that removes, moves, merges or rewrites lane entries
 * the caller did not address one by one (a hygiene apply, a derived-page
 * refresh) is refused with the fixed text below local reach, before its
 * first durable step, while any lane holds an entry in `private`. On a
 * store without such entries, in a dry run, and at local reach it runs as
 * before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

const HELD = "Brain/research/zqcoarse-held.md";

/** A lane page with a fixed title stamp. */
const page = (body: string): string =>
  `---\ntitle: Zqcoarse\ncreated_at: 2026-11-01T00:00:00Z\n---\n\n${body}\n`;

function env(withPrivate: boolean): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-coarse-");
  lanes.push(e);
  writeLaneText(e.vault, join(e.vault, "Brain/research/zqcoarse-shared.md"), page("shared body"));
  if (withPrivate) {
    writeLaneText(e.vault, join(e.vault, HELD), page(`held body ${REGION}`));
    expect(laneEntryInPrivate(e.vault, join(e.vault, HELD))).toBe(true);
  }
  return e;
}

const records = (e: LaneEnv): string[] => e.laneRecords().map((r) => JSON.stringify(r));

const CALLS: ReadonlyArray<Record<string, unknown>> = [
  { mode: "apply", ids: ["zqcoarse-none"] },
  { mode: "refresh" },
];

describe("a bulk lane verb below local reach on a store with private entries", () => {
  for (const args of CALLS) {
    test(`remote ${String(args["mode"])}: the fixed refusal before any write`, async () => {
      const e = env(true);
      const before = records(e);
      const answer = await call(server(e), "brain_hygiene", args);
      expect({
        refused: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
        names: answer.includes("zqcoarse-held"),
        records: records(e),
      }).toEqual({ refused: true, names: false, records: before });
    });

    test(`remote ${String(args["mode"])} on a store without private entries runs as before`, async () => {
      const answer = await call(server(env(false)), "brain_hygiene", args);
      expect(answer.includes(LANE_ENTRY_WITHHELD_MESSAGE)).toBe(false);
      expect(answer).toContain(`"mode"`);
    });

    test(`remote ${String(args["mode"])} as a dry run, and a local call, are not refused`, async () => {
      const e = env(true);
      const dry = await call(server(e), "brain_hygiene", { ...args, dry_run: true });
      const local = await call(localServer(e), "brain_hygiene", args);
      expect([dry, local].map((a) => a.includes(LANE_ENTRY_WITHHELD_MESSAGE))).toEqual([
        false,
        false,
      ]);
    });
  }
});
