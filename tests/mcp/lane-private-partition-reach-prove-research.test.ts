/**
 * A create the caller addresses below local reach (prove-research): a
 * `brain_research_report` whose page a private report holds, under the
 * same title or under another title on the stem the ladder would take
 * first (claim 8).
 *
 * Each test seeds the private report through the local server (its
 * finding carries a private region), records every lane record of the
 * store, makes the remote call, and compares. The same call through a
 * local server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { slugify } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const TITLE = "Zqprove quarterly report";
const OTHER_TITLE = "Zqprove Quarterly Report";
const SOURCE = "https://example.com/zqprove";
const TODAY = new Date().toISOString().slice(0, 10);

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(prefix: string): LaneEnv {
  const lane = makeLaneEnv("store", `osb-lane-prove-research-${prefix}-`);
  lanes.push(lane);
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

/** The report pages `partition` holds on `TODAY`, from the fold of every partition. */
function reports(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "reports" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

function args(title: string, statement: string): Record<string, unknown> {
  return { title, sources: [SOURCE], findings: [{ statement, sources: [SOURCE] }] };
}

/** A private report of `title` on `TODAY`, through the local server. */
async function seedPrivate(e: LaneEnv, title: string): Promise<string> {
  const local = await callJson(
    localServer(e),
    "brain_research_report",
    args(title, `zqprove finding ${REGION}`),
  );
  expect(local["error"]).toBeUndefined();
  expect(reports(e, "private")).toHaveLength(1);
  expect(reports(e, "shared")).toEqual([]);
  const stem = reports(e, "private")[0]!;
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "reports", `${stem}.md`))).toBe(true);
  return stem;
}

describe("a research report whose page a private report holds", () => {
  test("a remote report that meets a private report of the same title writes nothing", async () => {
    const e = env("same");
    const stem = await seedPrivate(e, TITLE);
    const before = records(e);

    const remote = await callJson(server(e), "brain_research_report", args(TITLE, "zqprove"));

    expect({
      answer: remote,
      shared: reports(e, "shared"),
      private: reports(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, join(e.vault, "Brain", "reports", `${stem}.md`)),
    }).toEqual({
      answer: { error: `brain_research_report: ${WITHHELD}` },
      shared: [],
      private: [stem],
      private_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a remote report whose first stem a private report of another title holds takes the next stem", async () => {
    const e = env("stem");
    const held = await seedPrivate(e, TITLE);
    expect(slugify(OTHER_TITLE)).toBe(slugify(TITLE));
    const digest = createHash("sha256").update(OTHER_TITLE, "utf8").digest("hex").slice(0, 8);
    const before = records(e);

    const remote = await callJson(
      server(e),
      "brain_research_report",
      args(OTHER_TITLE, "zqprove other finding"),
    );

    expect(remote["error"] ?? null).toBeNull();
    const shared = reports(e, "shared");
    expect(shared).toEqual([`${TODAY}-${slugify(TITLE)}-${digest}`]);
    expect(shared[0]!.endsWith(`-${digest}`)).toBe(true);
    expect({
      created: remote["created"],
      private: reports(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, join(e.vault, "Brain", "reports", `${held}.md`)),
    }).toEqual({ created: true, private: [held], private_kept: true });
    expect(records(e).filter((r) => r.startsWith("private "))).toEqual(
      before.filter((r) => r.startsWith("private ")),
    );
  });

  test("a local report of the same title rewrites the private report in place", async () => {
    const e = env("local");
    const stem = await seedPrivate(e, TITLE);
    const local = await callJson(localServer(e), "brain_research_report", args(TITLE, "zqprove"));
    expect(local["error"] ?? null).toBeNull();
    expect({
      created: local["created"],
      shared: reports(e, "shared"),
      private: reports(e, "private"),
    }).toEqual({ created: false, shared: [], private: [stem] });
  });
});
