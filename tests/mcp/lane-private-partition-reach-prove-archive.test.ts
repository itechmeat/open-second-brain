/**
 * An allocation ladder below local reach (prove-archive): a removal into
 * an archive or history folder whose first free slot a `private` entry
 * already holds (claim 10).
 *
 * Each test seeds the private entry on the slot the move would take
 * first, records every lane record of the store, makes the remote call,
 * and compares: the move lands on the next free slot and the private
 * entry's records are byte-identical. The same call through a local
 * server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { obligationsArchiveDir, pledgesArchiveDir } from "../../src/core/brain/paths.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, moveLanePage } from "../../src/core/store/lane-pages.ts";
import { titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const TITLE = "Zqprove ladder entry";
const SOURCE = "Notes/zqprove-source.md";
const EVIDENCE = ["We will ship the report."];
const SCOPE = "zqprove-ladder";
const TODAY = new Date().toISOString().slice(0, 10);

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-prove-archive-");
  lanes.push(lane);
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
  writeFileSync(join(lane.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
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

/** The live entries of `lane` in `partition`, from the fold of every partition. */
function entries(e: LaneEnv, lane: string, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([, value]) =>
        value.lane === lane &&
        fold.privateKeys.has(`${value.lane}/${value.entry}`) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

/** A private entry at `to`, moved from the live private entry at `from`. */
function holdSlot(e: LaneEnv, from: string, to: string): void {
  expect(laneEntryInPrivate(e.vault, from)).toBe(true);
  moveLanePage(e.vault, from, to);
  expect(laneEntryInPrivate(e.vault, to)).toBe(true);
}

const OBLIGATION_ARGS = { operation: "add", title: TITLE, cadence: "weekly" };
const PLEDGE_ARGS = {
  operation: "add",
  title: TITLE,
  due: "2026-12-01",
  source: SOURCE,
  evidence: EVIDENCE,
  agent: AGENT,
};

function slugOf(answer: Record<string, unknown>, key: string): string {
  return String((answer[key] as Record<string, unknown>)["slug"]);
}

describe("an archive move whose first slot a private entry holds", () => {
  test("a remote obligation remove whose archive slot a private entry holds lands on the next slot", async () => {
    const e = env();
    const local = localServer(e);
    await callJson(local, "brain_obligation", {
      ...OBLIGATION_ARGS,
      notes: `zqprove notes ${REGION}`,
    });
    const slug = titleSlug(TITLE);
    const slot = join(obligationsArchiveDir(e.vault), `${slug}.md`);
    holdSlot(e, join(e.vault, "Brain", "obligations", `${slug}.md`), slot);
    const added = await callJson(local, "brain_obligation", OBLIGATION_ARGS);
    expect(slugOf(added, "obligation")).toBe(slug);
    const before = records(e);

    const remote = await callJson(server(e), "brain_obligation", { operation: "remove", slug });

    expect(remote["error"] ?? null).toBeNull();
    expect({
      shared: entries(e, "obligations", "shared"),
      private: entries(e, "obligations", "private"),
      private_kept: laneEntryInPrivate(e.vault, slot),
    }).toEqual({
      shared: [`archive/${slug}-2`],
      private: [`archive/${slug}`],
      private_kept: true,
    });
    expect(records(e).filter((r) => r.startsWith("private "))).toEqual(
      before.filter((r) => r.startsWith("private ")),
    );
  });

  test("a local obligation remove with the same private archive entry lands on the same slot", async () => {
    const e = env();
    const local = localServer(e);
    await callJson(local, "brain_obligation", {
      ...OBLIGATION_ARGS,
      notes: `zqprove notes ${REGION}`,
    });
    const slug = titleSlug(TITLE);
    const slot = join(obligationsArchiveDir(e.vault), `${slug}.md`);
    holdSlot(e, join(e.vault, "Brain", "obligations", `${slug}.md`), slot);
    await callJson(local, "brain_obligation", OBLIGATION_ARGS);
    const removed = await callJson(local, "brain_obligation", { operation: "remove", slug });
    expect({
      error: removed["error"] ?? null,
      shared: entries(e, "obligations", "shared"),
      private_kept: laneEntryInPrivate(e.vault, slot),
    }).toEqual({
      error: null,
      shared: [`archive/${slug}-2`],
      private_kept: true,
    });
  });

  test("a remote pledge remove whose archive slot a private entry holds lands on the next slot", async () => {
    const e = env();
    const local = localServer(e);
    const hidden = await callJson(local, "brain_pledge", {
      ...PLEDGE_ARGS,
      notes: `zqprove notes ${REGION}`,
    });
    expect(hidden["error"]).toBeUndefined();
    const slug = slugOf(hidden, "pledge");
    const slot = join(pledgesArchiveDir(e.vault), `${slug}.md`);
    holdSlot(e, join(e.vault, "Brain", "pledges", `${slug}.md`), slot);
    await callJson(local, "brain_pledge", PLEDGE_ARGS);
    expect(entries(e, "pledges", "shared")).toEqual([slug]);
    const before = records(e);

    const remote = await callJson(server(e), "brain_pledge", { operation: "remove", slug });

    expect(remote["error"] ?? null).toBeNull();
    expect({
      shared: entries(e, "pledges", "shared"),
      private: entries(e, "pledges", "private"),
      private_kept: laneEntryInPrivate(e.vault, slot),
    }).toEqual({
      shared: [`archive/${slug}-2`],
      private: [`archive/${slug}`],
      private_kept: true,
    });
    expect(records(e).filter((r) => r.startsWith("private "))).toEqual(
      before.filter((r) => r.startsWith("private ")),
    );
  });

  test("a remote intention move to history whose first slot a private entry holds lands on the next slot", async () => {
    const e = env();
    const local = localServer(e);
    const first = await callJson(local, "brain_intention", {
      operation: "set",
      scope: SCOPE,
      text: `zqprove held intention ${REGION}`,
    });
    expect(first["error"]).toBeUndefined();
    const dir = join(e.vault, "Brain", "intentions");
    const slot = join(dir, "history", `${SCOPE}-${TODAY}.md`);
    holdSlot(e, join(dir, `${SCOPE}.md`), slot);
    const second = await callJson(local, "brain_intention", {
      operation: "set",
      scope: SCOPE,
      text: "zqprove shared intention",
    });
    expect(second["error"]).toBeUndefined();
    expect(entries(e, "intentions", "shared")).toEqual([SCOPE]);
    const before = records(e);

    const remote = await callJson(server(e), "brain_intention", {
      operation: "move",
      scope: SCOPE,
    });

    expect(remote["error"] ?? null).toBeNull();
    expect({
      archive_path_in_answer: "archive_path" in remote,
      shared: entries(e, "intentions", "shared"),
      private: entries(e, "intentions", "private"),
      private_kept: laneEntryInPrivate(e.vault, slot),
    }).toEqual({
      archive_path_in_answer: false,
      shared: [`history/${SCOPE}-${TODAY}-2`],
      private: [`history/${SCOPE}-${TODAY}`],
      private_kept: true,
    });
    expect(records(e).filter((r) => r.startsWith("private "))).toEqual(
      before.filter((r) => r.startsWith("private ")),
    );
  });
});
