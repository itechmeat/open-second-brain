/**
 * The least time worth starting a decision request with (design D20). A
 * request started with only a few milliseconds of its budget left gets a
 * timeout it cannot meet, and a hosted provider may still bill the
 * request it received. So no request starts while less than
 * {@link MIN_REQUEST_MS} is left, nor with a timeout below it: the use
 * stops as if its share of the budget were spent, and today's result
 * stands for what it did not ask. The floor holds for each attempt of a
 * fallback chain (`runDecision` with `requestFloor`), and the time the
 * call spent preparing its request counts against its budget.
 */

/**
 * 250 ms: the floor skill attachment already keeps before it starts its
 * second request (`SKILLS_STAGE2_MIN_REMAINING_MS`). A hosted round trip
 * rarely answers in less, and it is a twelfth of the default 3 s request
 * timeout, so a pass with the default budget loses at most that much.
 */
export const MIN_REQUEST_MS = 250;

/**
 * The timeout of the next attempt of a fallback chain when `leftMs` of
 * the call's budget is left for `entriesLeft` entries, or `null` when no
 * attempt may start. The chain splits its one budget evenly, but never
 * below the floor: an entry whose share would fall below it is not
 * attempted, and its time goes to the entries that are (the earlier
 * ones, which the configured order prefers). This is the one place the
 * floor is computed; {@link mayStartRequest} is its single-entry case.
 */
export function attemptTimeoutMs(leftMs: number, entriesLeft: number): number | null {
  const fitting = Math.min(entriesLeft, Math.floor(leftMs / MIN_REQUEST_MS));
  return fitting < 1 ? null : Math.floor(leftMs / fitting);
}

/**
 * Whether a request may start at `nowMs` when none may run past `untilMs`
 * and its own timeout is `timeoutMs`: the floor holds for the time the
 * request really gets, the smaller of the two.
 */
export function mayStartRequest(nowMs: number, untilMs: number, timeoutMs: number): boolean {
  return attemptTimeoutMs(Math.min(untilMs - nowMs, timeoutMs), 1) !== null;
}
