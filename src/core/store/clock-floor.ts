/**
 * The in-process clock floor of each store (design D3, receive rule).
 *
 * Reading is receiving: every shard read raises the floor of its store to
 * the newest stamp it read (`reader.ts`), and the next stamp this process
 * issues for that store takes the receive rule over the floor first
 * (`clock-store.ts` `tickClock`, called by the appender). So a write that
 * replaces, removes or raises a record the operation read orders after
 * that record in every fold, even when the record's device stamped it
 * ahead of this machine's wall clock.
 *
 * The module holds only the map, with no file or lock import, so the
 * readers that load it stay light (a hook that reads a shard loads no
 * lock module).
 */

import { resolve } from "node:path";

import { maxHlc, type Hlc } from "./hlc.ts";

/** The newest stamp read from each store in this process, by resolved store root. */
const floors = new Map<string, Hlc>();

/** Record that a record stamped `clock` was read from the store at `storeRoot`. */
export function noteObservedClock(storeRoot: string, clock: Hlc): void {
  const key = resolve(storeRoot);
  const seen = floors.get(key);
  if (seen === undefined || maxHlc(seen, clock) !== seen) floors.set(key, clock);
}

/** The newest stamp this process read from the store at `storeRoot`, or null. */
export function observedClockFloor(storeRoot: string): Hlc | null {
  return floors.get(resolve(storeRoot)) ?? null;
}
