/**
 * Hybrid logical clock (design D3): pure arithmetic, no I/O.
 *
 * A stamp is `{ physical, counter }`, written `"<physical_ms>.<counter>"`.
 * Records fold in (hlc, device, id) order, and two rules keep that order
 * causal across machines whose wall clocks disagree:
 *
 *  - Send: when the wall clock is ahead of the local clock's physical part,
 *    the stamp is the wall clock with counter 0; otherwise the physical
 *    part stays and the counter increments. Every stamp a device issues is
 *    therefore strictly greater than the one before, even when the wall
 *    clock steps backwards.
 *  - Receive: observing a remote stamp raises the local clock to at least
 *    that stamp. The next send then orders after it, so a record written
 *    in reply to a remote record folds after it even when the replying
 *    machine's wall clock is behind. A remote stamp more than
 *    {@link HLC_MAX_DRIFT_MS} ahead of the wall clock (a broken clock, a
 *    damaged line) is not adopted, so one bad record cannot push this
 *    device's clock into the far future for good.
 *
 * Persistence of the local clock per device lives in `clock-store.ts`.
 */

/** One hybrid logical clock stamp. */
export interface Hlc {
  /** Milliseconds since the Unix epoch. */
  readonly physical: number;
  /** Tie-breaker within one physical millisecond. */
  readonly counter: number;
}

/** Remote stamps further ahead of the wall clock than this are not adopted (one day). */
export const HLC_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

/** The clock before anything was sent or observed. */
export const HLC_ZERO: Hlc = Object.freeze({ physical: 0, counter: 0 });

/** Non-negative integers without leading zeros: `0`, `7`, `1762400000123`. */
const HLC_RE = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,9})$/;

/** The text form written into the envelope's `hlc` field. */
export function formatHlc(clock: Hlc): string {
  return `${clock.physical}.${clock.counter}`;
}

/** Parse the text form; `null` for anything that is not exactly one stamp. */
export function parseHlc(text: string): Hlc | null {
  const match = HLC_RE.exec(text);
  if (match === null) return null;
  const physical = Number(match[1]);
  const counter = Number(match[2]);
  if (!Number.isSafeInteger(physical) || !Number.isSafeInteger(counter)) return null;
  return { physical, counter };
}

/** Negative, zero or positive as `a` orders before, with or after `b`. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

/** The larger of two stamps. */
export function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}

/**
 * Send rule: the stamp for a new local record, given the local clock and
 * the wall clock in milliseconds. The result is also the new local clock.
 */
export function sendHlc(local: Hlc, wallMs: number): Hlc {
  const wall = Math.max(0, Math.floor(wallMs));
  if (wall > local.physical) return { physical: wall, counter: 0 };
  return { physical: local.physical, counter: local.counter + 1 };
}

/**
 * Receive rule: the local clock after observing `remote`. It never moves
 * backwards and never falls below the remote stamp, so the next
 * {@link sendHlc} orders after everything observed so far. The wall clock
 * only matters when it is ahead of both. A remote stamp more than
 * {@link HLC_MAX_DRIFT_MS} ahead of the wall clock is ignored.
 */
export function receiveHlc(local: Hlc, remote: Hlc, wallMs: number): Hlc {
  const wall = Math.max(0, Math.floor(wallMs));
  const adoptable = remote.physical - wall <= HLC_MAX_DRIFT_MS;
  const known = adoptable ? maxHlc(local, remote) : local;
  if (wall > known.physical) return { physical: wall, counter: 0 };
  return known;
}
