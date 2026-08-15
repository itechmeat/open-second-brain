/**
 * Process self-watchdog: a hard time ceiling a spawned hook arms on itself.
 *
 * Lifecycle hooks (session-start context injection, session capture) run as
 * short-lived processes in the host runtime. A hung hook (slow embedding,
 * stuck reindex, filesystem stall) must never orphan a process or block the
 * host agent indefinitely. Arming this ceiling guarantees the process exits
 * cleanly at the deadline instead of hanging forever.
 *
 * The timer is `unref`ed so it never itself keeps the process alive: on a
 * healthy run the hook finishes and exits normally well before the ceiling,
 * and `disarm()` clears the timer. The ceiling only fires when the process is
 * still alive at the deadline (blocked on async I/O), at which point it runs a
 * best-effort `onExpire` side effect (an audit line) and exits 0 - never a
 * partial or poisoned write, and never the blocking exit code.
 *
 * Note: a JavaScript timer cannot interrupt a fully-synchronous CPU hang on a
 * single thread; the realistic hook hangs are asynchronous (network fetch,
 * fs stall on a mounted volume), which this covers. That limit is exactly why
 * the host's own per-hook timeout is the OUTER bound and this ceiling sits
 * inside it: the host can kill a wedged process this timer cannot reach.
 *
 * ## Which deadline is authoritative
 *
 * The host's is. It is enforced from outside the process, it survives a
 * synchronous hang, and every entry in `hooks/hooks.json` declares it. What
 * this module adds is a CLEAN exit just before that deadline: a hook killed by
 * the host writes no audit line and leaves no record of why it stopped, while
 * one that hits this ceiling runs `onExpire` and exits 0.
 *
 * That only works if this ceiling is strictly SMALLER than the declared host
 * timeout. It was not: the default was 55 s behind a declared 10 s, so under
 * the shipped configuration the self-ceiling could never once have fired and
 * the module's "second line of defence" was in fact the first and only one.
 * The default is now derived from the declared timeout, and
 * `tests/hooks/process-ceiling.test.ts` asserts the RELATION between the two
 * rather than either number - so changing one without the other fails there
 * instead of silently disarming the watchdog again.
 */

/**
 * The per-hook timeout every entry in `hooks/hooks.json` declares, in
 * seconds. Mirrored here because JSON cannot import a constant; the test
 * suite reads the file and asserts the two agree.
 */
export const HOOK_HOST_TIMEOUT_SECONDS = 10;

/**
 * How far in front of the host's deadline this ceiling fires. It buys the
 * `onExpire` side effect - a single audit-line append - and the exit, which
 * is comfortably under two seconds even on a loaded machine with a slow
 * filesystem.
 */
export const HOOK_CEILING_HEADROOM_MS = 2_000;

/** Derived, never typed twice: see the module docblock for the ordering. */
export const DEFAULT_HOOK_CEILING_MS = HOOK_HOST_TIMEOUT_SECONDS * 1_000 - HOOK_CEILING_HEADROOM_MS;

/** Floor below which a configured ceiling is treated as a typo and ignored. */
const MIN_HOOK_CEILING_MS = 1_000;

/**
 * Resolve the hook time ceiling from the environment. A valid integer at or
 * above the floor wins; anything else (absent, non-numeric, below the floor)
 * falls back to the default so a typo can never disable the watchdog.
 */
export function resolveHookCeilingMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["OPEN_SECOND_BRAIN_HOOK_CEILING_MS"]?.trim();
  if (!raw) return DEFAULT_HOOK_CEILING_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_HOOK_CEILING_MS) return DEFAULT_HOOK_CEILING_MS;
  return Math.floor(value);
}

export interface ProcessCeilingOptions {
  /** Hard deadline in milliseconds. */
  readonly ceilingMs: number;
  /** Best-effort side effect run just before exit (e.g. an audit line). */
  readonly onExpire?: () => void;
  /** Exit hook; defaults to `process.exit`. Injectable for tests. */
  readonly exit?: (code: number) => void;
  /** Timer scheduler; defaults to an `unref`ed `setTimeout`. Injectable. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  /** Timer canceller; defaults to `clearTimeout`. Injectable. */
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Arm the ceiling. Returns an idempotent `disarm()` the caller invokes in a
 * `finally` once the real work completes.
 */
export function armProcessCeiling(opts: ProcessCeilingOptions): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const clearTimer = opts.clearTimer ?? defaultClearTimer;

  const handle = setTimer(() => {
    try {
      opts.onExpire?.();
    } catch {
      // The audit side effect is best-effort; never let it block the exit.
    }
    exit(0);
  }, opts.ceilingMs);

  let disarmed = false;
  return () => {
    if (disarmed) return;
    disarmed = true;
    clearTimer(handle);
  };
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const timer = setTimeout(fn, ms);
  // Do not let the ceiling itself keep the event loop alive.
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
