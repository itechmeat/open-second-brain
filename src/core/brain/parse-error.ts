/**
 * Typed parse failure for Brain artifacts, carrying the offending file
 * as a field rather than inside its prose.
 *
 * `o2b brain doctor` renders a finding as `<code>: <message> (<path>)`,
 * appending the location from the finding's structured `path` field. A
 * parser that also embedded the path in its message therefore made every
 * parse-error line name the same file twice. The v1.40.0 convention is
 * that a finding carries data as fields, so the doctor reads {@link
 * BrainParseError.detail} — the location-free prose — and supplies the
 * path itself.
 *
 * Dropping the path from what a caller reads would have been a silent
 * loss of operator context: several surfaces (`o2b brain reject`, `brain
 * merge`, `brain pin`, the apply-evidence paths) print
 * `(exc as Error).message` bare and have nowhere else to put a location.
 * So `message` keeps it — composed by {@link withLocation}, the ONE
 * place a filesystem location is appended to a message, rather than by a
 * template repeated at every throw site.
 *
 * What that composition does and does not preserve, precisely:
 *
 *   - Every throw site whose message ALREADY carried the path composes
 *     the same sentence as before. Where the historical sentence put the
 *     location somewhere other than the end — `BrainStatusFolderMismatchError`
 *     names it inside a `(path=…, status=…, folder=…)` group — the site
 *     supplies that sentence through {@link BrainParseErrorOptions.composedMessage},
 *     so an operator matching on the text sees no change.
 *   - Four optional-field helpers in `preference.ts` (`optionalStringList`,
 *     `optionalNullableString`, `optionalNumber`, `optionalStringArray`)
 *     threw with NO location at all. They now carry one. That is a gain,
 *     not a preserved shape, and it is the only wording change in the set.
 *
 * The class is deliberately not vocabulary-aware: it knows a file and a
 * failure, and nothing about preferences, retirement, or doctor codes.
 * Classification stays in `doctor.ts`, which maps the bare detail onto
 * its own code population.
 */

/**
 * Append a filesystem location to a failure description.
 *
 * The single definition of the located form. Both {@link BrainParseError}
 * and any surface that needs to re-derive the sentence from
 * `(detail, path)` go through here, so the shape cannot drift between
 * the parsers and their readers.
 */
export function withLocation(detail: string, path: string): string {
  return `${detail} (${path})`;
}

export interface BrainParseErrorOptions extends ErrorOptions {
  /**
   * The full sentence for `message`, replacing {@link withLocation}'s
   * composition. For a throw site whose historical sentence named the
   * location somewhere other than the end, so that keeping the location
   * costs no wording change. `detail` still carries none, so the doctor
   * reads the same field it reads everywhere else.
   */
  readonly composedMessage?: string;
}

/**
 * A Brain artifact that could not be parsed, plus the file it came from.
 *
 * `detail` is the failure with no location in it; `path` is the location;
 * `message` is the two joined by {@link withLocation}, unless the site
 * supplied its own composition. A consumer that renders its own path
 * field reads `detail`; a consumer that prints one string reads
 * `message`.
 */
export class BrainParseError extends Error {
  /** Absolute path of the file whose parse failed. */
  readonly path: string;
  /** The failure, with no location in it. */
  readonly detail: string;

  constructor(detail: string, path: string, options?: BrainParseErrorOptions) {
    super(options?.composedMessage ?? withLocation(detail, path), options);
    this.name = "BrainParseError";
    this.detail = detail;
    this.path = path;
  }
}
