/**
 * Wait for the detached self-heal reindex children a test started.
 *
 * A `SessionStart` hook (or a full-scope server start) on an initialised
 * vault with no search index spawns a detached `o2b search reindex` and
 * returns at once. The child outlives the test: a test that removes its
 * temp vault and HOME in `afterEach` races it, and the child's Bun start
 * (its transpiler cache under `$HOME/.bun`) and its metrics row recreate
 * the directories the test just removed (issue #194).
 *
 * The parent writes a `spawned` row carrying a run id, and the child writes
 * its terminal row under the same id (`self-heal-reindex.ts`). Waiting for
 * every spawn row to be paired is waiting on the child's own completion
 * event, not on a clock; the budget only bounds a child that died without
 * recording, and is reported when it is spent.
 */

import {
  readSelfHealReindexRows,
  SELF_HEAL_SPAWN,
} from "../../src/core/maintenance/self-heal-reindex.ts";

/** A cold Bun start plus a rebuild of a near-empty vault, with headroom for a slow runner. */
const CHILD_BUDGET_MS = 60_000;
const POLL_INTERVAL_MS = 50;

function unpairedRunIds(vault: string): string[] {
  const rows = readSelfHealReindexRows(vault);
  const done = new Set(rows.filter((r) => r.outcome !== null).map((r) => r.runId));
  return rows
    .filter((r) => r.decision === SELF_HEAL_SPAWN.spawned && r.runId !== null)
    .map((r) => r.runId as string)
    .filter((id) => !done.has(id));
}

export async function waitForSelfHealChildren(
  vault: string,
  budgetMs = CHILD_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let pending = unpairedRunIds(vault);
  while (pending.length > 0 && Date.now() < deadline) {
    // Nothing in-process holds the detached child: looking again is the
    // only way to learn it finished.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(POLL_INTERVAL_MS);
    pending = unpairedRunIds(vault);
  }
  if (pending.length > 0) {
    throw new Error(`self-heal reindex children never finished: ${pending.join(", ")}`);
  }
}
