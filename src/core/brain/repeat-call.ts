/**
 * A repeat of a call that adds to a list on each call (an obligation's
 * completion for a date, an intention's next version) answers as already
 * recorded and writes nothing: a call whose read-back could not be
 * verified may be repeated, and the repeat must not add the same item a
 * second time (change `tool-lane-write-keeps-standing`, the review of its
 * second batch).
 */

/** Whether a completion for `date` is already the latest of `completions` (newest first). */
export function completionRepeated(completions: ReadonlyArray<string>, date: string): boolean {
  return completions[0] === date;
}

/** `value`, marked as the answer of a repeated call that wrote nothing. */
export function alreadyRecorded<T extends object>(
  value: T,
): T & { readonly alreadyRecorded: true } {
  return Object.freeze({ ...value, alreadyRecorded: true as const });
}

/** Whether `value` is the answer of a repeated call that wrote nothing. */
export function isAlreadyRecorded(value: object): boolean {
  return (value as { readonly alreadyRecorded?: unknown }).alreadyRecorded === true;
}
