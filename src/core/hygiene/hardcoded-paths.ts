/**
 * Hardcoded home / absolute path hygiene scanner.
 *
 * OSB is installed across many machines and vault roots. A concrete
 * home path baked into shipped source, docs, generated examples, or a
 * plugin config template leaks the author's host layout and hands the
 * reader a copy-paste command that only works on the author's machine.
 * This module flags those paths deterministically so a CI report (and
 * the `hardcoded-paths.test.ts` gate) can keep them out of the tree.
 *
 * What it flags: a POSIX `/home/<user>/…` or `/Users/<user>/…` prefix,
 * or a Windows `X:\Users\<user>\…` prefix, whose `<user>` segment names
 * a *specific* account rather than a placeholder. Placeholder segments
 * (`user`, `you`, `me`, single/double-letter stand-ins, …) are intended
 * examples and pass. `~`, `$HOME`, `/path/to/…`, and non-home absolute
 * paths (`/usr`, `/etc`, `/tmp`, `#!/usr/bin/env …`) are never flagged.
 *
 * Escape hatch: a line carrying the marker `hygiene:allow-path` (in a
 * comment) suppresses findings on that line, so a genuinely intentional
 * concrete path can be annotated instead of triggering a false positive.
 *
 * Pure and text-based: {@link scanText} takes a string and returns
 * findings; {@link scanFiles} walks a file list. Neither mutates state.
 */

// ----- Public types ---------------------------------------------------------

/** Stable detector identifiers so callers can filter without parsing. */
export type HardcodedPathDetector = "unix-home" | "windows-home";

export interface HardcodedPathFinding {
  /** File the match came from, exactly as the caller passed it. */
  readonly file: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** 1-based column (UTF-16 code unit) of the match start. */
  readonly column: number;
  /** The matched path prefix, e.g. `/home/sergey`. */ // hygiene:allow-path
  readonly match: string;
  /** The offending user segment, e.g. `sergey`. */
  readonly segment: string;
  /** Which detector fired. */
  readonly detector: HardcodedPathDetector;
}

// ----- Detectors ------------------------------------------------------------

/**
 * POSIX home prefix: `/home/<seg>` or `/Users/<seg>`. The segment must
 * start with an alphanumeric so a literal `/Users/...` placeholder does
 * not capture a segment and therefore never fires.
 */
const UNIX_HOME_RE = /\/(?:home|Users)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/**
 * Windows home prefix: `X:\Users\<seg>`. Tolerates both a raw backslash
 * (Markdown / shell text) and an escaped `\\` (inside a source string
 * literal) between the components.
 */
const WINDOWS_HOME_RE = /[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/**
 * Marker that suppresses findings on the line that carries it. Keep the
 * literal out of any scanned example by placing it in a comment.
 */
export const HYGIENE_ALLOW_MARKER = "hygiene:allow-path";

/**
 * Segments treated as intentional placeholders rather than real
 * accounts. Case-insensitive. Anything one or two characters long
 * (`u`, `x`, `me`, …) is also treated as a placeholder — real leaks are
 * full usernames, and short stand-ins are ubiquitous in examples.
 */
const PLACEHOLDER_SEGMENTS: ReadonlySet<string> = new Set([
  "user",
  "users",
  "username",
  "youruser",
  "you",
  "your",
  "yourname",
  "yourusername",
  "name",
  "someone",
  "somebody",
  "example",
  "changeme",
  "home",
  "alice",
  "bob",
  "carol",
  "dave",
  "foo",
  "bar",
  "baz",
  "qux",
]);

function isPlaceholderSegment(segment: string): boolean {
  if (segment.length <= 2) return true;
  return PLACEHOLDER_SEGMENTS.has(segment.toLowerCase());
}

// ----- Scanning -------------------------------------------------------------

/**
 * Scan a single text blob. `file` is echoed verbatim into every finding
 * so the caller controls whether paths are absolute or repo-relative.
 * Lines carrying {@link HYGIENE_ALLOW_MARKER} contribute no findings.
 */
export function scanText(content: string, file: string): HardcodedPathFinding[] {
  const findings: HardcodedPathFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes(HYGIENE_ALLOW_MARKER)) continue;
    collect(line, i + 1, file, UNIX_HOME_RE, "unix-home", findings);
    collect(line, i + 1, file, WINDOWS_HOME_RE, "windows-home", findings);
  }
  return findings;
}

function collect(
  line: string,
  lineNumber: number,
  file: string,
  re: RegExp,
  detector: HardcodedPathDetector,
  out: HardcodedPathFinding[],
): void {
  // `re` is a module-level global regex; reset lastIndex per line so the
  // stateful `.exec` loop starts clean and never skips a line's first hit.
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const segment = m[1]!;
    if (isPlaceholderSegment(segment)) continue;
    out.push({
      file,
      line: lineNumber,
      column: m.index + 1,
      match: m[0],
      segment,
      detector,
    });
  }
}

/**
 * Scan a list of `{ file, content }` pairs. The caller is responsible
 * for reading files and deciding which ones are in scope; this keeps the
 * core pure and trivially testable. Findings preserve input order, then
 * line, then column.
 */
export function scanFiles(
  files: ReadonlyArray<{ readonly file: string; readonly content: string }>,
): HardcodedPathFinding[] {
  const out: HardcodedPathFinding[] = [];
  for (const { file, content } of files) {
    out.push(...scanText(content, file));
  }
  return out;
}

/** One-line human summary of a finding, suitable for a CI report. */
export function formatFinding(f: HardcodedPathFinding): string {
  return `${f.file}:${f.line}:${f.column}: hardcoded home path '${f.match}' (segment '${f.segment}', ${f.detector})`;
}
