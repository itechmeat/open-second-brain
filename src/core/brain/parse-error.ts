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

/**
 * A Brain artifact that could not be parsed, plus the file it came from.
 *
 * `detail` is the failure with no location in it; `path` is the location;
 * `message` is the two joined by {@link withLocation}. A consumer that
 * renders its own path field reads `detail`; a consumer that prints one
 * string reads `message`.
 */
export class BrainParseError extends Error {
  /** Absolute path of the file whose parse failed. */
  readonly path: string;
  /** The failure, with no location in it. */
  readonly detail: string;

  constructor(detail: string, path: string, options?: ErrorOptions) {
    super(withLocation(detail, path), options);
    this.name = "BrainParseError";
    this.detail = detail;
    this.path = path;
  }
}
