/**
 * Machine maintenance a remote call triggers (prove-procedural): the two
 * mark operations of `brain_procedural_memory` below local reach while the
 * usage counters of another procedure are withheld from the caller
 * (claim 4).
 *
 * Each test seeds one procedure page in `private` and one in `shared`,
 * ticks the private one's counters through the local server (so the usage
 * file names it), records the private records of the store and the usage
 * lines, makes the remote call on the shared one, and compares: the
 * private procedure's counters are still there for a local reader, the
 * shared procedure's counter advanced, and the answer names nothing of
 * the private procedure. The same call through a local server on a twin
 * store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listProceduralMemory, proceduralEntryId } from "../../src/core/brain/procedural-memory.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const HELD = "Brain/procedures/zqprove-held.md";
const SHARED = "Brain/procedures/zqprove-shared.md";
const HELD_ID = proceduralEntryId(HELD);
const SHARED_ID = proceduralEntryId(SHARED);

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A procedure page's text. */
function procedure(title: string, held: boolean): string {
  return [
    "---",
    "kind: brain-procedure",
    "tags: [docs]",
    "triggers: [release]",
    `title: ${title}`,
    "---",
    `# ${title}`,
    "",
    `zqprove step ${held ? REGION : "shared"}`,
    "",
  ].join("\n");
}

/** The private lane records of the store, serialized and sorted. */
function privateRecords(e: LaneEnv): string[] {
  return e
    .laneRecords("private")
    .map((r) => JSON.stringify(r))
    .toSorted();
}

/** The counters of the two procedures a local reader sees, by id. */
function localCounters(e: LaneEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of listProceduralMemory(e.vault, e.env.configPath)) {
    out[entry.id] = {
      used: entry.usedCount,
      success: entry.successCount,
      failure: entry.failureCount,
    };
  }
  return out;
}

/** Both procedures indexed, the private one's counters ticked; its counters before the remote call. */
async function seeded(prefix: string): Promise<{ e: LaneEnv; heldBefore: unknown }> {
  const e = makeLaneEnv("store", `osb-lane-prove-procedural-${prefix}-`);
  lanes.push(e);
  writeLaneText(e.vault, join(e.vault, HELD), procedure("Zqprove held procedure", true));
  writeLaneText(e.vault, join(e.vault, SHARED), procedure("Zqprove shared procedure", false));
  expect(laneEntryInPrivate(e.vault, join(e.vault, HELD))).toBe(true);
  expect(laneEntryInPrivate(e.vault, join(e.vault, SHARED))).toBe(false);
  const local = localServer(e);
  const reconciled = await callJson(local, "brain_procedural_memory", { operation: "reconcile" });
  expect(reconciled["error"]).toBeUndefined();
  for (const operation of ["mark_used", "mark_used", "mark_outcome"]) {
    // oxlint-disable-next-line no-await-in-loop -- one store, marked in order
    const marked = await callJson(local, "brain_procedural_memory", {
      operation,
      id: HELD_ID,
      ...(operation === "mark_outcome" ? { outcome: "success" } : {}),
    });
    expect(marked["error"]).toBeUndefined();
  }
  const before = localCounters(e);
  expect(Object.keys(before).toSorted()).toEqual([HELD_ID, SHARED_ID].toSorted());
  return { e, heldBefore: before[HELD_ID] };
}

describe("a mark below local reach while another procedure's counters are withheld", () => {
  test("a remote mark_used keeps the withheld counters and advances the addressed one", async () => {
    const { e, heldBefore } = await seeded("used");
    const privateBefore = privateRecords(e);

    const remote = await callJson(server(e), "brain_procedural_memory", {
      operation: "mark_used",
      id: SHARED_ID,
    });

    const after = localCounters(e);
    expect(remote["error"] ?? null).toBeNull();
    expect(remote["id"]).toBe(SHARED_ID);
    expect(remote["usedCount"]).toBe(1);
    expect({
      names_held: JSON.stringify(remote).includes(HELD_ID),
      held: after[HELD_ID],
      shared: after[SHARED_ID],
      private_records_same: privateRecords(e).length === privateBefore.length,
      held_page_kept: laneEntryInPrivate(e.vault, join(e.vault, HELD)),
    }).toEqual({
      names_held: false,
      held: heldBefore,
      shared: { used: 1, success: 0, failure: 0 },
      private_records_same: true,
      held_page_kept: true,
    });
    expect(privateRecords(e)).toEqual(privateBefore);
  });

  test("a remote mark_outcome keeps the withheld counters and advances the addressed one", async () => {
    const { e, heldBefore } = await seeded("outcome");
    const privateBefore = privateRecords(e);

    const remote = await callJson(server(e), "brain_procedural_memory", {
      operation: "mark_outcome",
      id: SHARED_ID,
      outcome: "failure",
    });

    const after = localCounters(e);
    expect(remote["error"] ?? null).toBeNull();
    expect({
      names_held: JSON.stringify(remote).includes(HELD_ID),
      held: after[HELD_ID],
      shared: after[SHARED_ID],
      private_records: privateRecords(e),
    }).toEqual({
      names_held: false,
      held: heldBefore,
      shared: { used: 0, success: 0, failure: 1 },
      private_records: privateBefore,
    });
  });

  test("a local mark_used on the shared procedure keeps the withheld counters", async () => {
    const { e, heldBefore } = await seeded("local");
    const local = await callJson(localServer(e), "brain_procedural_memory", {
      operation: "mark_used",
      id: SHARED_ID,
    });
    expect(local["error"] ?? null).toBeNull();
    const after = localCounters(e);
    expect({ held: after[HELD_ID], shared: after[SHARED_ID] }).toEqual({
      held: heldBefore,
      shared: { used: 1, success: 0, failure: 0 },
    });
  });
});
