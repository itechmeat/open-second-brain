/**
 * IndexWatchRunner (Indexer Durability suite, t_ea80ddb5).
 *
 * The testable core of `o2b search watch`'s lifecycle. Two
 * responsibilities, both deliberately free of `fs.watch`, timers, and
 * OS signals so they can be unit-tested directly:
 *
 *   - Single-flight flush: one index pass at a time; concurrent
 *     `flush()` calls share the in-flight promise instead of stacking
 *     overlapping passes.
 *   - Graceful shutdown: stop accepting new flushes, abort the
 *     in-flight pass via an AbortSignal (which the indexer honours at
 *     its next file / embed-batch boundary), and await it to settle -
 *     bounded by a grace window so a wedged pass cannot block exit
 *     forever. `graceMs <= 0` aborts and returns without awaiting.
 *
 * The CLI provides the `index` callback (which runs `indexVault` with
 * the supplied signal and reports stats) and wires the watcher, the
 * debounce planner, and SIGINT/SIGTERM to this runner.
 */

export interface IndexWatchRunnerDeps {
  /**
   * Run exactly one index pass, honouring the abort signal. It owns its
   * own reporting and swallows its own recoverable errors; an abort may
   * surface as a rejection, which the runner treats as an expected
   * stop.
   */
  readonly index: (signal: AbortSignal) => Promise<unknown>;
  /** Milliseconds the shutdown awaits an aborted in-flight pass. */
  readonly graceMs: number;
  /** Resolves after `ms`; injectable for tests. Defaults to setTimeout. */
  readonly graceWaiter?: (ms: number) => Promise<void>;
}

function defaultGraceWaiter(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not keep the event loop alive solely for the grace timer.
    if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  });
}

export class IndexWatchRunner {
  private readonly deps: IndexWatchRunnerDeps;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;

  constructor(deps: IndexWatchRunnerDeps) {
    this.deps = deps;
  }

  /** True once shutdown has begun; no further flushes are accepted. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** True while an index pass is in flight. */
  get isFlushing(): boolean {
    return this.running !== null;
  }

  /**
   * Run one index pass unless shutdown began or a pass is already in
   * flight (single-flight: the in-flight promise is returned instead).
   */
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const controller = new AbortController();
    this.controller = controller;
    const run = (async () => {
      try {
        await this.deps.index(controller.signal);
      } catch {
        // The index callback reports its own recoverable failures; an
        // abort surfaces here on shutdown and is the expected stop.
      }
    })().finally(() => {
      this.running = null;
      this.controller = null;
    });
    this.running = run;
    return run;
  }

  /**
   * Stop accepting flushes, abort any in-flight pass, and await it to
   * settle at a cooperative boundary - bounded by the grace window.
   * Idempotent: a second call is a no-op.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const inflight = this.running;
    if (inflight === null) return;
    this.controller?.abort();
    if (this.deps.graceMs <= 0) return;
    const wait = this.deps.graceWaiter ?? defaultGraceWaiter;
    await Promise.race([inflight, wait(this.deps.graceMs)]);
  }
}
