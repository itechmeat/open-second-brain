/**
 * What the last topic planning pass on this machine found, kept in the
 * device-local state so `o2b status` can show it without reading the
 * store again: the topics created, the records no topic holds, and how
 * many of those name no project (an attribute only: topics group records
 * by theme, whatever project they name or do not name).
 *
 * Written only by the view writer's planning pass (the one that plans),
 * atomically, after each planned pass. Never synced: it describes this
 * machine's last pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { readDeviceId } from "../config.ts";
import { inspectStore } from "../store/store-open.ts";
import { deviceStateDirFor, resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { VIEW_STATE_DIR } from "../view/constants.ts";

/** The file, under the store's device-local view state. */
const OUTCOME_FILE = "topic-plan-last.json";

/** The counts of one planning pass. */
export interface TopicPlanCounts {
  /** Topics the pass created. */
  readonly created: number;
  /** Records no topic holds that the pass read (signals, notes, decisions). */
  readonly unassigned: number;
  /** Of those, how many name no project. */
  readonly withoutProject: number;
}

export interface TopicPlanOutcome extends TopicPlanCounts {
  /** When the pass ran (ISO-8601). */
  readonly at: string;
  /**
   * The counts as a machine that holds only `shared` would read them (the
   * shared topics and records), for a caller below local reach. Absent in
   * a file an earlier release wrote.
   */
  readonly shared?: TopicPlanCounts;
}

function outcomePath(deviceStateDir: string): string {
  return join(deviceStateDir, VIEW_STATE_DIR, OUTCOME_FILE);
}

/** Record the outcome of a planned pass. Best effort: a failed write changes nothing else. */
export function recordTopicPlanOutcome(deviceStateDir: string, outcome: TopicPlanOutcome): void {
  try {
    atomicWriteFileSync(outcomePath(deviceStateDir), `${JSON.stringify(outcome)}\n`);
  } catch {
    // The next pass writes it again.
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The outcome of this machine's last planning pass for the configured
 * store, or `null` when there is none to read (no store, no device id, no
 * pass yet, a file that does not parse).
 */
export function readTopicPlanOutcome(configPath?: string): TopicPlanOutcome | null {
  try {
    const root = resolveConfiguredStoreRoot(configPath).root;
    const store = inspectStore(root);
    if (store === null || readDeviceId(configPath) === null) return null;
    const dir = deviceStateDirFor(store.storeId, processDirsEnv());
    const parsed = JSON.parse(readFileSync(outcomePath(dir), "utf8")) as Record<string, unknown>;
    const created = count(parsed["created"]);
    const unassigned = count(parsed["unassigned"]);
    const withoutProject = count(parsed["withoutProject"]);
    const at = parsed["at"];
    if (created === null || unassigned === null || withoutProject === null) return null;
    if (typeof at !== "string") return null;
    const shared = countsOf(parsed["shared"]);
    return { at, created, unassigned, withoutProject, ...(shared !== null ? { shared } : {}) };
  } catch {
    return null;
  }
}

function countsOf(value: unknown): TopicPlanCounts | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  const created = count(fields["created"]);
  const unassigned = count(fields["unassigned"]);
  const withoutProject = count(fields["withoutProject"]);
  if (created === null || unassigned === null || withoutProject === null) return null;
  return { created, unassigned, withoutProject };
}

/**
 * The outcome a caller may read: as stored at local reach; below it
 * (`withholdsPrivate`), the counts a machine that holds only `shared`
 * would compute, so no count includes a private record (the contract of
 * `store/caller-reach.ts` and doctor's `withholdsPrivate`). An outcome
 * without those counts (written by an earlier release) is withheld whole.
 */
export function topicPlanOutcomeAtReach(
  outcome: TopicPlanOutcome | null,
  withholdsPrivate: boolean,
): TopicPlanOutcome | null {
  if (outcome === null || !withholdsPrivate) return outcome;
  if (outcome.shared === undefined) return null;
  return { at: outcome.at, ...outcome.shared };
}
