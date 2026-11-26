/**
 * A write decision taken from the narrowed view (identity-brief): a brief
 * view that writes a report snapshot under the day's key, while the store
 * holds that day's snapshot in `private`.
 *
 * Each test seeds the shared snapshot through the local server (report
 * snapshots on), raises it to `private` as a raise from another device
 * arrives, records every lane record of the store, makes the remote call,
 * and compares. The same call through a local server on a twin store is
 * the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { raiseWithoutTombstone } from "./lane-private-partition-reach-store-fixture.ts";
import { callJson, localServer, server } from "./lane-private-partition-reach-writes-fixture.ts";

const DATE = "2026-11-20";
const ENV_KEY = "OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS";
const VIEWS = [
  { view: "daily", args: { date: DATE } },
  { view: "weekly", args: { week_end: DATE } },
  { view: "digest", args: { since: "2026-11-19T00:00:00Z", until: `${DATE}T23:00:00Z` } },
] as const;

const lanes: LaneEnv[] = [];
const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

/** A store whose day's snapshot of `view` the local server wrote. */
async function seeded(
  view: (typeof VIEWS)[number]["view"],
  args: Record<string, unknown>,
): Promise<LaneEnv> {
  if (!savedEnv.has(ENV_KEY)) savedEnv.set(ENV_KEY, process.env[ENV_KEY]);
  process.env[ENV_KEY] = "true";
  const lane = makeLaneEnv("store", "osb-lane-identity-brief-");
  lanes.push(lane);
  const first = await callJson(localServer(lane), "brain_brief", { view, ...args });
  expect(first["error"]).toBeUndefined();
  expect(JSON.stringify(first["delta"])).toContain('"prior_date":null');
  return lane;
}

/** Every lane record of both partitions, serialized and sorted: the store's lane bytes. */
function records(e: LaneEnv): string[] {
  return (["shared", "private"] as const)
    .flatMap((partition) =>
      e.laneRecords(partition).map((r) => `${partition} ${JSON.stringify(r)}`),
    )
    .toSorted();
}

/** The snapshot record of `view` for `DATE`, whichever partition holds it. */
function snapshotRecords(e: LaneEnv, view: string): ReadonlyArray<Record<string, unknown>> {
  return e
    .laneRecords()
    .map((r) => r.body)
    .filter(
      (body) =>
        String(body["entry"]).includes(`${view}/${DATE}.json`) ||
        (String(body["entry"]) === `${DATE}.json` && String(body["lane"]).includes(view)),
    );
}

/** Raise the day's snapshot of `view` to `private`, as another device's raise arrives. */
function raise(e: LaneEnv, view: string): string {
  const [record] = snapshotRecords(e, view);
  expect(record).toBeDefined();
  raiseWithoutTombstone(e, record!);
  const path = join(e.vault, "Brain", "reports", view, `${DATE}.json`);
  expect(laneEntryInPrivate(e.vault, path)).toBe(true);
  return path;
}

describe("a brief view that meets a private snapshot of its day", () => {
  for (const { view, args } of VIEWS) {
    test(`a remote ${view} view answers and leaves a private snapshot of its day untouched`, async () => {
      const e = await seeded(view, args);
      raise(e, view);
      const before = records(e);
      const answer = await callJson(server(e), "brain_brief", { view, ...args });
      expect({
        error: answer["error"] ?? null,
        delta: answer["delta"] ?? null,
        kept: records(e).length === before.length,
      }).toEqual({ error: null, delta: null, kept: true });
      expect(records(e)).toEqual(before);
    });

    test(`a local ${view} view takes the day's snapshot over the private one and reports a delta`, async () => {
      const e = await seeded(view, args);
      const path = raise(e, view);
      const before = records(e);
      const answer = await callJson(localServer(e), "brain_brief", { view, ...args });
      // A delta is reported (the snapshot was taken); the day's payload is
      // byte-identical, so the rewrite is skipped and nothing is appended.
      expect({
        error: answer["error"] ?? null,
        has_delta: answer["delta"] !== undefined,
        still_private: laneEntryInPrivate(e.vault, path),
        same: records(e).length === before.length,
      }).toEqual({ error: null, has_delta: true, still_private: true, same: true });
    });
  }
});
