/**
 * Hints to the garbage collector for the long reads of the store
 * migration (change migration-memory-peak). A walk of the store or of the
 * legacy tree holds little at a time, but each record or file it parses is
 * garbage at once; left alone, the runtime lets that garbage grow the heap
 * with the store, far past what the walk holds. A full collection of a
 * heap that holds little costs a few milliseconds.
 *
 * Off Bun (the OpenClaw plugin under Node) there is no hint and nothing
 * changes.
 */

/** Records or rows a long read handles between two hints. */
export const GC_HINT_EVERY = 32_768;

let counted = 0;

/** Collect now: at the boundary of a phase that left garbage behind. */
export function gcHint(): void {
  const runtime = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
  runtime?.gc(true);
}

/** Count one record or row of a long read; collect every {@link GC_HINT_EVERY}. */
export function gcHintTick(): void {
  counted += 1;
  if (counted % GC_HINT_EVERY === 0) gcHint();
}
