/**
 * Pure debounce/coalesce planner for the file-watcher index sync (Unit 3
 * of the Vault Integrity & Trust suite).
 *
 * A vault edit fires a burst of filesystem events; re-indexing on every
 * raw event would thrash. This planner answers one question - "which
 * changed paths have been quiet long enough to index now?" - given an
 * explicit clock value. It is deliberately dependency-free and never
 * reads the clock itself, so the coalescing behaviour is deterministic
 * and unit-testable without a real `fs.watch` or timers.
 *
 * The lifecycle around it (the CLI verb) owns the OS watcher, the timer
 * that calls {@link take}, and the single-flight guard that prevents
 * overlapping index passes. The planner owns no I/O.
 */

export interface IndexWatchPlannerOptions {
  /**
   * Quiet window in milliseconds. A path is due only once no further
   * change has been recorded for it within this window. Each new change
   * to the same path resets its window, so a file under continuous
   * editing is indexed once it settles rather than on every keystroke.
   */
  readonly debounceMs: number;
}

export class IndexWatchPlanner {
  private readonly debounceMs: number;
  private readonly lastSeen = new Map<string, number>();

  constructor(opts: IndexWatchPlannerOptions) {
    if (!Number.isFinite(opts.debounceMs) || opts.debounceMs < 0) {
      throw new Error(
        `IndexWatchPlanner debounceMs must be a non-negative finite number, got ${opts.debounceMs}`,
      );
    }
    this.debounceMs = opts.debounceMs;
  }

  /** Number of paths currently waiting out their quiet window. */
  get pendingCount(): number {
    return this.lastSeen.size;
  }

  /** Record a change to `path` observed at `atMs`, resetting its window. */
  record(path: string, atMs: number): void {
    this.lastSeen.set(path, atMs);
  }

  /**
   * Paths whose quiet window has fully elapsed as of `now`, sorted for
   * deterministic output. Non-mutating - use {@link take} to also remove
   * them.
   */
  due(now: number): string[] {
    const out: string[] = [];
    for (const [path, seen] of this.lastSeen) {
      if (now - seen >= this.debounceMs) out.push(path);
    }
    return out.toSorted();
  }

  /**
   * Return the due paths (see {@link due}) and remove them from the
   * pending set, so the caller can hand them to one index pass without
   * re-flushing them next tick. Paths still inside their window stay
   * pending.
   */
  take(now: number): string[] {
    const ready = this.due(now);
    for (const path of ready) this.lastSeen.delete(path);
    return ready;
  }

  /**
   * Earliest wall-clock time at which some pending path becomes due, or
   * `null` when nothing is pending. Lets the lifecycle sleep until the
   * next flush instead of polling on a fixed interval.
   */
  nextDueAt(): number | null {
    let min: number | null = null;
    for (const seen of this.lastSeen.values()) {
      const due = seen + this.debounceMs;
      if (min === null || due < min) min = due;
    }
    return min;
  }
}
