/**
 * The transition import without a manual command (task 2.4, design
 * D11a): the end of a dream pass and the session-start path run it,
 * through the same trigger as the view render (`view/auto-render.ts`), so
 * a switched machine keeps importing what machines still on an old
 * release write into the legacy tree.
 *
 * Rules:
 *
 *  - **Only where it matters.** A vault is configured and this device
 *    holds its own `device-switched`. While some roster device is still
 *    on the legacy layout (`legacyDevices`: the cohort, the devices seen
 *    at earlier imports, and the devices in today's legacy shard names, a
 *    directory listing), the import runs as below. Once none is, it runs
 *    only when a legacy file changed against the watermark: a device
 *    never seen before that syncs a page and no log shard names itself
 *    nowhere, and its page is still imported. The migration records the
 *    watermark at its final delta pass, so the first run starts from a
 *    point whose content was imported; with no watermark at all the
 *    import runs and the journal decides what it still lacks.
 *  - **Throttled from hooks.** The session-start trigger runs at most once
 *    an hour per device; the stamp is written before the import.
 *  - **Cheap when idle.** A per-file watermark (size, mtime, inode) of
 *    every legacy file a record mapping reads is kept in the device-local
 *    state. A run whose files all match it only lists and stats them; any
 *    difference runs the import, which itself skips every item already in
 *    the store. Items held back for a partition this machine does not
 *    hold are retried once the held partitions change, not on every run.
 *  - **Fail open.** Every failure is returned, never thrown.
 */

import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { isSyncConflictName, parseShardedName } from "../brain/ledger-shards.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { migrationCatalogue, recordDestination } from "./catalogue.ts";
import { migrationDir } from "./journal.ts";
import { deviceSwitchedHere } from "../store/store-only.ts";
import { legacyDevices } from "./migration-records.ts";
import { importLateLegacyWrites, type TransitionResult } from "./transition.ts";
import {
  heldPartitions,
  legacyFileStamps,
  readJson,
  readWatermark,
  writeJson,
} from "./transition-watermark.ts";

/** How often the session-start trigger may run the import. */
export const AUTO_TRANSITION_INTERVAL_MS = 60 * 60 * 1000;

const THROTTLE_FILE = "transition-auto.json";

export type AutoTransitionTrigger = "dream" | "session-start";

export type AutoTransitionResult =
  | { readonly status: "not-switched" | "no-legacy-devices" | "throttled" | "idle" }
  | ({ readonly status: "imported" } & TransitionResult)
  | { readonly status: "error"; readonly error: string };

/**
 * The device ids in the names of the legacy shards a record mapping reads:
 * directory listings only, no file is opened or stat'ed, so the check
 * stays cheap on every hook run.
 */
export function legacyShardDevices(vault: string): string[] {
  const out = new Set<string>();
  const list = (dir: string): Dirent[] => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const entry of migrationCatalogue(vault)) {
    if (recordDestination(entry) === null) continue;
    for (const locator of entry.locators) {
      if (locator.shape !== "jsonl") continue;
      const dirs = locator.subdirs
        ? list(locator.dir)
            .filter((e) => e.isDirectory())
            .map((e) => join(locator.dir, e.name))
        : [locator.dir];
      for (const dir of dirs) {
        for (const file of list(dir)) {
          if (isSyncConflictName(file.name)) continue;
          const shardId = parseShardedName(file.name, locator.grammar)?.shardId ?? "";
          if (shardId !== "") out.add(shardId);
        }
      }
    }
  }
  return [...out].toSorted();
}

function sameStamps(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export interface AutoTransitionOptions {
  readonly store: StoreHandle;
  readonly vault: string | null;
  readonly agent: string;
  readonly vaultId: string | null;
  readonly trigger: AutoTransitionTrigger;
  readonly now?: () => number;
}

/** One automatic transition import; see the module header for when it runs. */
export function runAutoTransition(options: AutoTransitionOptions): AutoTransitionResult {
  try {
    const { store, vault } = options;
    if (vault === null || !deviceSwitchedHere(store, store.device))
      return { status: "not-switched" };
    const dir = migrationDir(store);
    const previous = readWatermark(store);
    // The devices in today's shard names count too: a device absent from
    // the initial tree (so from the cohort) that syncs its first shard
    // after every known device switched is still on the legacy layout.
    const known = [...(previous?.devices ?? []), ...legacyShardDevices(vault)];
    const legacyLeft = legacyDevices(store, known).length > 0;
    const nowMs = (options.now ?? Date.now)();
    if (options.trigger === "session-start") {
      const last = readJson<{ at?: number }>(join(dir, THROTTLE_FILE))?.at;
      if (
        typeof last === "number" &&
        nowMs - last >= 0 &&
        nowMs - last < AUTO_TRANSITION_INTERVAL_MS
      ) {
        return { status: "throttled" };
      }
      writeJson(dir, THROTTLE_FILE, { at: nowMs });
    }
    // Stats only: no legacy file is opened unless one changed.
    const stamps = legacyFileStamps(vault);
    const partitionsSame =
      previous?.held_partitions === undefined ||
      previous.held_partitions.join(",") === heldPartitions(store).join(",");
    const unchanged = previous !== null && partitionsSame && sameStamps(stamps, previous.files);
    // With no watermark (a machine switched before its migration recorded
    // one) the tree is not trusted as a baseline: the import runs and the
    // journal decides what it still lacks.
    if (unchanged) return { status: legacyLeft ? "idle" : "no-legacy-devices" };
    // The import records the watermark itself, from the stamps taken
    // before its final pass (`transition-watermark.ts`).
    const result = importLateLegacyWrites(vault, store, options.agent, options.vaultId, {
      recordWatermark: true,
    });
    return { status: "imported", ...result };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
