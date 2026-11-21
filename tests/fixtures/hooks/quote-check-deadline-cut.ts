/**
 * A test preload that makes the quote-check hook's wall clock jump at a
 * chosen read, so a deadline cut lands exactly where a test wants it.
 *
 * The hook reads the clock in four places (`hooks/answer-quote-check.ts`):
 * the start of the budget, the check before each message, the check before
 * each span, and the check before each candidate of a span's walk. The
 * candidate check is the one that decides whether a note is measured, so a
 * test that wants "the budget ran out between the first and the second
 * candidate" needs the clock to pass the deadline there and not before.
 *
 * Timing alone cannot say that: a wall-clock budget is a race between the
 * test machine's speed and the work the walk does. This preload replaces
 * the clock for the child process alone - it counts the reads the HOOK
 * makes (a read is counted when the stack names the hook's own file) and
 * returns a time past the deadline from the chosen read on. The count is
 * therefore a property of the hook's code, not of the machine it runs on.
 *
 * The environment it reads:
 *   - `OSB_TEST_CLOCK_JUMP_AT`: the read (counted from one) that jumps;
 *   - `OSB_TEST_CLOCK_JUMP_BY`: how far past the clock jumps, in
 *     milliseconds (default 60000, far beyond any budget a test sets);
 *   - `OSB_TEST_CLOCK_MARKER`: the file name the stack must name for a
 *     read to count (default the quote-check hook).
 *
 * Nothing here reaches production code: the hook reads `Date.now()` as it
 * always has, and the preload lives in the child's process only.
 */

const realNow = Date.now;

const jumpAt = Number(process.env["OSB_TEST_CLOCK_JUMP_AT"] ?? "0");
const jumpBy = Number(process.env["OSB_TEST_CLOCK_JUMP_BY"] ?? "60000");
const marker = process.env["OSB_TEST_CLOCK_MARKER"] ?? "answer-quote-check.ts";

let reads = 0;

Date.now = (): number => {
  const stack = new Error().stack ?? "";
  if (stack.includes(marker)) {
    reads += 1;
    if (reads >= jumpAt) return realNow() + jumpBy;
  }
  return realNow();
};
