/**
 * The least time worth starting a decision request with (design D20). A
 * request started with only a few milliseconds of its budget left gets a
 * timeout it cannot meet, and a hosted provider may still bill the
 * request it received. So no request starts while less than
 * {@link MIN_REQUEST_MS} is left, nor with a timeout below it: the use stops as if its share of the
 * budget were spent, and today's result stands for what it did not ask.
 */

/**
 * 250 ms: the floor skill attachment already keeps before it starts its
 * second request (`SKILLS_STAGE2_MIN_REMAINING_MS`). A hosted round trip
 * rarely answers in less, and it is a twelfth of the default 3 s request
 * timeout, so a pass with the default budget loses at most that much.
 */
export const MIN_REQUEST_MS = 250;

/**
 * Whether a request may start at `nowMs` when none may run past `untilMs`
 * and its own timeout is `timeoutMs`: the floor holds for the time the
 * request really gets, the smaller of the two.
 */
export function mayStartRequest(nowMs: number, untilMs: number, timeoutMs: number): boolean {
  return Math.min(untilMs - nowMs, timeoutMs) >= MIN_REQUEST_MS;
}
