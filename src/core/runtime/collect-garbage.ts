/**
 * A full garbage collection between the steps of a long batch pass, when
 * the process holds enough memory for it to matter.
 *
 * Each step of a dream pass over a large store (the consolidation, topic
 * planning, the transition import, the render) reads the store whole and
 * keeps little of it. The collector left the garbage of one step standing
 * while the next one read again, so the peak memory of a pass was the sum
 * of its steps rather than the largest of them: measured on a migrated
 * store of 375 thousand records (300 MB of shards), the peak fell from
 * 5 GB to under 2 GB with a collection between steps.
 *
 * Below {@link STEP_COLLECT_MIN_RSS_BYTES} it does nothing: a small vault
 * (and every test) pays no collection.
 */

/** Resident memory above which a collection between steps is worth its pause. */
export const STEP_COLLECT_MIN_RSS_BYTES = 256 * 1024 * 1024;

/** Collect garbage now, when the process holds more than the threshold. */
export function collectBetweenSteps(): void {
  if (typeof Bun === "undefined") return;
  if (process.memoryUsage.rss() < STEP_COLLECT_MIN_RSS_BYTES) return;
  Bun.gc(true);
}
