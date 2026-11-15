/**
 * Retiring the store records of files that became machine state after the
 * migration imported them (task 3.10, design D15 item 2).
 *
 * A machine switched before the procedural usage counters, graph and
 * hints became machine state holds them as `lane-entry` records, the
 * migration's import of the legacy files. Each switched machine adopts
 * them into its own machine state on first read
 * (`brain/procedural-graph.ts` `readProceduralState`), and the records are
 * never written again. They stay in the store while a rollback is still
 * possible: a rollback replays post-switch records into the legacy tree,
 * so a tombstone written earlier would remove the legacy file it was
 * imported from. Once the legacy tree has left the vault a rollback is
 * refused, and the removal retires them here: each one this machine has
 * adopted into its own state (its copy is there after the adoption) gets
 * one tombstone in the partition the entry lives in; one it could not
 * adopt, or whose tombstone could not be written, stays live. A machine that never read them before the tombstone
 * arrives rebuilds the graph and hints on its next reconcile and starts
 * its counters from those its index still carries.
 */

import { existsSync } from "node:fs";

import { appendRecord } from "../store/appender.ts";
import { AUTHORITY_FIELD } from "../store/constants.ts";
import { foldLaneEntries, LANE_ENTRY_REMOVE_KIND, laneEntryKey } from "../store/lane-records.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreHandle } from "../store/store-open.ts";
import type { StoreRecord } from "../store/envelope.ts";
import type { StorePartition } from "../store/constants.ts";
import {
  proceduralGraphPath,
  proceduralHintsPath,
  proceduralMemoryUsagePath,
} from "../brain/paths.ts";
import { readProceduralState } from "../brain/procedural-graph.ts";

/** The lane of the procedural memory files. */
const PROCEDURAL_LANE = "procedural-memory";

/** The entries that are machine state now, with the location each one is adopted into. */
const ADOPTED: ReadonlyArray<{ readonly entry: string; readonly path: (v: string) => string }> =
  Object.freeze([
    { entry: "usage.jsonl", path: proceduralMemoryUsagePath },
    { entry: "graph.json", path: proceduralGraphPath },
    { entry: "hints.json", path: proceduralHintsPath },
  ]);

/**
 * Adopt the entries into this machine's state, then tombstone each one the
 * store still holds live. Returns the `<lane>/<entry>` keys retired.
 */
export function retireAdoptedLaneEntries(
  store: StoreHandle,
  vault: string,
  agent: string,
): string[] {
  const partitionOf = new Map<string, StorePartition>();
  const records: StoreRecord[] = [];
  for (const partition of store.partitions) {
    for (const record of readStreamRecords(store.root, partition, { stream: "events" }).records) {
      partitionOf.set(record.id, partition);
      records.push(record);
    }
  }
  const fold = foldLaneEntries(records);
  const retired: string[] = [];
  for (const { entry, path } of ADOPTED) {
    const key = laneEntryKey(PROCEDURAL_LANE, entry);
    const state = fold.entries.get(key);
    if (state === undefined || state.removed || state.value === null) continue;
    // Only a record this machine holds its own copy of is retired: an
    // adoption whose write failed (a full disk, a device-local folder it
    // may not write) leaves the record live, the one copy there is.
    try {
      readProceduralState(vault, path(vault));
    } catch {
      continue;
    }
    if (!existsSync(path(vault))) continue;
    try {
      appendRecord(store, {
        partition: partitionOf.get(state.winner) ?? "shared",
        stream: "events",
        kind: LANE_ENTRY_REMOVE_KIND,
        agent,
        body: { [AUTHORITY_FIELD]: "human", lane: PROCEDURAL_LANE, entry },
      });
    } catch {
      // Left live, read only by a machine without its own copy yet.
      continue;
    }
    retired.push(key);
  }
  return retired;
}
