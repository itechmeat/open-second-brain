/**
 * In-flight request bookkeeping, shared by both MCP transports.
 *
 * Neither transport could shut down without cutting a request in half.
 * The HTTP handle's `close` was `server.close()` and nothing else - it
 * stops the listener and returns, while the promise returned by
 * `handleHttpRequest` is floated by the `createServer` callback, so a
 * tool call mid-flight was answered with a closed socket. The stdio loop
 * had no shutdown path at all.
 *
 * What both need is the same small thing: a count of what is running, a
 * way to say "no more", and a bounded wait. That is this module, and it
 * is deliberately transport-shaped rather than signal-shaped:
 *
 *   - It installs NO signal handler and knows no exit codes. Signals are
 *     process-global and the process belongs to the CLI, which already
 *     owns that vocabulary in `src/cli/interrupt.ts`; a second module
 *     reaching for `process.once("SIGTERM")` is how two conventions get
 *     shipped. `src/cli/mcp-drain.ts` is the caller that wires them.
 *   - It never abandons a request quietly. When the deadline expires the
 *     outcome CARRIES the requests that were still open, so the caller
 *     can name them. A drain that dropped them silently would be the
 *     same defect as the bare `server.close()`, one layer up.
 */

/** How long a drain waits for in-flight work before it gives up, in ms. */
export const DEFAULT_DRAIN_DEADLINE_MS = 10_000;

/** The environment variable that moves that deadline. */
export const DRAIN_DEADLINE_ENV = "O2B_MCP_DRAIN_MS";

/**
 * The deadline this process uses.
 *
 * A value that is not a non-negative finite number THROWS rather than
 * falling back to the default: an operator who set the variable did so to
 * change the behaviour, and quietly using ten seconds because they typed
 * `10s` is exactly the misleading quiet this release removes.
 */
export function resolveDrainDeadlineMs(env: NodeJS.ProcessEnv): number {
  const raw = env[DRAIN_DEADLINE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DRAIN_DEADLINE_MS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${DRAIN_DEADLINE_ENV}=${raw} is not a shutdown deadline; set it to a non-negative ` +
        `number of milliseconds (the default is ${DEFAULT_DRAIN_DEADLINE_MS}), or unset it`,
    );
  }
  return parsed;
}

/** What a transport is doing about new work. */
export const DRAIN_STATE = Object.freeze({
  /** Accepting new requests. */
  serving: "serving",
  /** Refusing new requests, finishing the ones already begun. */
  draining: "draining",
  /** Drained (or the deadline expired) and shut. */
  drained: "drained",
  /** The deadline expired with requests still open. */
  deadlineExpired: "deadline_expired",
} as const);

export type DrainState = (typeof DRAIN_STATE)[keyof typeof DRAIN_STATE];

/** One request the transport has begun and not yet answered. */
export interface InFlightRequest {
  readonly id: number;
  /** What it is, in the transport's own terms - `POST /`, `tools/call`. */
  readonly label: string;
  /** `Date.now()` when the transport began it. */
  readonly started_at: number;
}

export interface DrainOutcome {
  /** {@link DRAIN_STATE.drained} or {@link DRAIN_STATE.deadlineExpired}. */
  readonly state: DrainState;
  readonly waited_ms: number;
  readonly deadline_ms: number;
  /** The requests still open when the deadline expired. Empty when drained. */
  readonly abandoned: ReadonlyArray<InFlightRequest>;
}

/**
 * The in-flight register for one transport.
 *
 * `begin` returns the `finish` for that one request rather than taking an
 * id back, so a caller cannot finish somebody else's request and cannot
 * forget which id was theirs. `finish` is idempotent: an HTTP response
 * that both ends normally and fires `close` must not decrement twice.
 */
export class RequestDrain {
  #state: DrainState = DRAIN_STATE.serving;
  #nextId = 1;
  readonly #open = new Map<number, InFlightRequest>();
  #settle: (() => void) | null = null;

  get state(): DrainState {
    return this.#state;
  }

  /** True once a drain has started; the transport must refuse new work. */
  get draining(): boolean {
    return this.#state !== DRAIN_STATE.serving;
  }

  get inFlight(): number {
    return this.#open.size;
  }

  /** The requests currently open, oldest first. */
  snapshot(): ReadonlyArray<InFlightRequest> {
    return [...this.#open.values()];
  }

  /** Register one request. Returns the idempotent finish for it. */
  begin(label: string): () => void {
    const id = this.#nextId++;
    this.#open.set(id, { id, label, started_at: Date.now() });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#open.delete(id);
      if (this.#open.size === 0 && this.#settle !== null) {
        const settle = this.#settle;
        this.#settle = null;
        settle();
      }
    };
  }

  /**
   * Stop accepting, then wait for the open requests up to `deadlineMs`.
   *
   * Resolves as soon as the last one finishes. A second call while a
   * drain is already running waits on the same completion rather than
   * starting a second timer - two signals in quick succession are one
   * shutdown.
   */
  async drain(deadlineMs: number): Promise<DrainOutcome> {
    const startedAt = Date.now();
    this.#state = DRAIN_STATE.draining;
    if (this.#open.size === 0) return this.#settled(startedAt, deadlineMs);

    const emptied = new Promise<true>((resolve) => {
      const previous = this.#settle;
      this.#settle = () => {
        previous?.();
        resolve(true);
      };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    const drained = await Promise.race([emptied, expired]);
    if (timer !== undefined) clearTimeout(timer);
    return drained ? this.#settled(startedAt, deadlineMs) : this.#expired(startedAt, deadlineMs);
  }

  #settled(startedAt: number, deadlineMs: number): DrainOutcome {
    this.#state = DRAIN_STATE.drained;
    return {
      state: DRAIN_STATE.drained,
      waited_ms: Date.now() - startedAt,
      deadline_ms: deadlineMs,
      abandoned: [],
    };
  }

  #expired(startedAt: number, deadlineMs: number): DrainOutcome {
    this.#state = DRAIN_STATE.deadlineExpired;
    return {
      state: DRAIN_STATE.deadlineExpired,
      waited_ms: Date.now() - startedAt,
      deadline_ms: deadlineMs,
      abandoned: this.snapshot(),
    };
  }
}

/**
 * The line an operator reads when the deadline beat the requests.
 *
 * Every abandoned request is named with how long it had been running,
 * because "three requests were dropped" and "a `tools/call` that had been
 * running for nine seconds was dropped" lead to different next steps -
 * and the second is the one that says whether the deadline is too short.
 */
export function describeAbandonedRequests(outcome: DrainOutcome): string {
  if (outcome.abandoned.length === 0) return "";
  const now = Date.now();
  const lines = outcome.abandoned.map(
    (request) => `  - ${request.label} (open for ${now - request.started_at}ms)`,
  );
  return (
    `[mcp] drain deadline of ${outcome.deadline_ms}ms expired with ` +
    `${outcome.abandoned.length} request(s) still open; closing anyway:\n` +
    `${lines.join("\n")}\n` +
    `[mcp] raise ${DRAIN_DEADLINE_ENV} if this shutdown needs longer\n`
  );
}
