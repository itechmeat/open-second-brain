/**
 * Fenced code blocks that hold arbitrary text safely.
 *
 * A fence must be longer than every backtick run inside the block, or a run
 * in the text closes the block early and what follows it is read as
 * Markdown. One helper, shared by every section that fences text it did not
 * write (the capture excerpt, the HTML parts list, the table note).
 */

/** The fence character; a backtick fence admits any info string. */
export const FENCE_CHAR = "`";

/** The shortest fence CommonMark recognises. */
export const MIN_FENCE_LENGTH = 3;

/** Every run of the fence character, to size a fence that contains them all. */
const FENCE_CHAR_RUN_RE = /`+/g;

/** A backtick fence longer than every backtick run in `text`. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(FENCE_CHAR_RUN_RE)) longest = Math.max(longest, run[0].length);
  return FENCE_CHAR.repeat(Math.max(MIN_FENCE_LENGTH, longest + 1));
}
