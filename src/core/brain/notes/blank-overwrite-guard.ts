/**
 * The blank-overwrite predicate (nothing-writes-silently, unit B).
 *
 * A note update carries a replacement body. When that body is empty, the
 * write is indistinguishable at the byte level from "delete everything
 * this page says" - and until this guard, that is exactly what happened,
 * reported as `updated: true`. An agent that composed an empty string
 * (a truncated generation, a variable that never got assigned, a
 * template that rendered to nothing) emptied the page and was told the
 * write succeeded.
 *
 * The rule is one line of logic and the whole of this module: replacing
 * a body that carries text with one that does not is refused unless the
 * caller SAYS it means to clear the page. Deleting a page's contents is
 * a legitimate thing to want; doing it by accident and being told it
 * worked is not.
 *
 * ## What counts as blank
 *
 * `trim().length === 0`. Whitespace-only is blank, because
 * `parseFrontmatter` trims the body it reads
 * (`vault.ts` - `text.slice(match[0].length).trim()`), so a page whose
 * body is three spaces reads back as an empty body on the next pass:
 * the bytes differ, the note does not. The same predicate already
 * governs `projectAppendNote`'s empty-content refusal, so the two note
 * writers agree on what "nothing" is rather than each deciding.
 *
 * A character that is not whitespace is content, however invisible -
 * U+200B ZERO WIDTH SPACE survives `trim` and therefore survives this
 * guard. The predicate deliberately does not invent a wider notion of
 * emptiness than the parser has: a guard stricter than the format it
 * protects would refuse writes the format would have kept.
 *
 * An existing body that is ALREADY blank has nothing to lose, so
 * blank-over-blank is not a refusal. A brand-new note is not an update
 * and never reaches here: `createNote` resolves an absent body to `""`
 * and writes a genuinely empty page, which is a page nobody had.
 *
 * ## Where this is deliberately NOT wired
 *
 * One seam: `projectUpdateNote` in `write-batch.ts`. That single call
 * covers both callers - `brain_update_note` (a one-operation batch) and
 * `brain_write_batch`'s `update_note` op. There is no third. The three
 * other write surfaces a reader might expect to find it on were
 * examined and refused, so nobody re-opens the question:
 *
 *   - `core/fs-atomic.ts` writes BYTES, not notes. It is the substrate
 *     under JSON state, manifests, JSONL shards, sqlite sidecars and
 *     install adapters across most of the tree; it has no concept of a
 *     body, and a "the new content is shorter" heuristic there would
 *     refuse legitimate writes of every other file format.
 *   - `core/brain/host-memory-write.ts` is append-only into a continuity
 *     record and already refuses empty content with a typed
 *     `empty_content` error. It replaces nothing, so there is nothing to
 *     blank.
 *   - `core/brain/inline.ts` is a parser and writes nothing at all;
 *     `inline-rewrite.ts` is the writer beside it and is line-preserving
 *     and insert-only, returning early when the text is unchanged. It
 *     cannot empty a body either.
 */

/** Inputs to {@link refuseBlankOverwrite}. */
export interface BlankOverwriteInput {
  /** The body currently on disk, as the frontmatter parser returned it. */
  readonly existingBody: string;
  /** The body the caller wants written in its place. */
  readonly nextBody: string;
  /** The caller explicitly asked to clear the page. Defaults to false. */
  readonly allowEmpty?: boolean;
}

/** Whether `body` says nothing the format would preserve. */
function isBlank(body: string): boolean {
  return body.trim().length === 0;
}

/**
 * Whether this update must be refused: a blank replacement over a body
 * that carries text, without an explicit `allowEmpty`.
 *
 * Pure - it reads no file and reaches nothing outside its argument, so
 * the caller decides what to do with the answer and owns the error type
 * its own surface speaks.
 */
export function refuseBlankOverwrite(input: BlankOverwriteInput): boolean {
  if (input.allowEmpty === true) return false;
  return isBlank(input.nextBody) && !isBlank(input.existingBody);
}
