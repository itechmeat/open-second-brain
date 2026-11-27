/**
 * A refused note create leaves no disposition row (change
 * `lane-reach-residuals`, the requirement "A refusal below local reach
 * comes before the call's first durable step", as package 6 settled it for
 * an ingest).
 *
 * Under a permissions document that asks, a note create is staged: its
 * disposition row was recorded before the staging met an open entry for
 * the same target held in `private` and gave the fixed answer. Below local
 * reach the reach checks of the staging now run before the row. The
 * refused call compares the raw records of both partitions; a local
 * control stages as before and records its row.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { queryDecisionLedger } from "../../src/core/brain/permissions/ledger.ts";
import { PERMISSIONS_DOCUMENT_SETTING } from "../../src/core/brain/permissions/document.ts";
import { setBrainSetting } from "../../src/core/brain/policy/settings-write.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const TARGET = "Notes/zqcreate-ledger.md";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A store whose permissions document stages every write, and a private staged note for `TARGET`. */
async function staged(name: string): Promise<LaneEnv> {
  const e = makeLaneEnv("store", `osb-lane-create-note-ledger-${name}-`);
  lanes.push(e);
  setBrainSetting(
    { vault: e.vault, authority: "human", agent: "operator" },
    PERMISSIONS_DOCUMENT_SETTING,
    "version: 1\ndefault_action: ask\n",
  );
  const first = await callJson(localServer(e), "brain_create_note", {
    path: TARGET,
    content: `zqcreate held text ${REGION}`,
  });
  expect(first["error"]).toBeUndefined();
  expect(JSON.stringify(first)).toContain("staged");
  return e;
}

function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

describe("a refused note create leaves no disposition row", () => {
  test("a remote create whose staged target a private open entry holds writes nothing", async () => {
    const e = await staged("remote");
    const rows = queryDecisionLedger(e.vault).length;
    const before = rawRecords(e);

    const remote = await callJson(server(e), "brain_create_note", {
      path: TARGET,
      content: "zqcreate open text",
    });

    expect({
      refused: JSON.stringify(remote).includes(WITHHELD),
      rows: queryDecisionLedger(e.vault).length - rows,
    }).toEqual({ refused: true, rows: 0 });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local create of the same target is refused as before, after its row", async () => {
    const e = await staged("local");
    const rows = queryDecisionLedger(e.vault).length;
    const local = await callJson(localServer(e), "brain_create_note", {
      path: TARGET,
      content: "zqcreate open text",
    });
    expect({
      refused: JSON.stringify(local).includes(WITHHELD),
      rows: queryDecisionLedger(e.vault).length - rows,
    }).toEqual({ refused: false, rows: 1 });
  });
});
