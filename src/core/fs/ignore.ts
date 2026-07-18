/**
 * Path-scope engine: a `.gitignore`-style matcher with nested composition.
 *
 * This is the one home for ignore-pattern matching shared by the hygiene repo
 * scan (which honors nested `.gitignore` files and `.git/info/exclude`) and
 * source-ingest scoping (which reuses it for `--exclude`). It implements the
 * documented gitignore subset - it does NOT claim full `git check-ignore`
 * parity. Supported semantics:
 *
 *   - blank lines and `#` comments are skipped; a leading `\#` / `\!` escapes;
 *   - trailing whitespace is stripped unless backslash-escaped;
 *   - a `!` prefix negates (re-includes) a match;
 *   - a leading `/` or an internal `/` anchors the pattern to the file's base
 *     directory; a slashless pattern matches the basename at any depth;
 *   - a trailing `/` restricts a pattern to directories;
 *   - `*` and `?` match within one path segment; a doubled star spans
 *     segments (trailing, leading, or between two segments);
 *   - the last matching rule wins, and rules from a deeper file override those
 *     from a shallower one (nearer-`!`-wins), with `.git/info/exclude` layered
 *     at the lowest precedence.
 *
 * A malformed pattern (an unterminated bracket class, or one that fails to
 * compile) is reported as a warning and produces no rule - it never silently
 * ignores a path.
 */

/** A pattern that could not be compiled, surfaced instead of silently dropped. */
export interface IgnoreWarning {
  /** Provenance of the ignore file, e.g. `src/.gitignore`. */
  readonly source: string;
  /** 1-based line number of the offending pattern. */
  readonly line: number;
  /** The raw pattern text. */
  readonly pattern: string;
  /** Why it was rejected. */
  readonly reason: string;
}

interface CompiledRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  /** Matches a path expressed relative to the owning layer's base directory. */
  readonly re: RegExp;
}

/** One parsed ignore file, scoped to the directory it governs. */
export interface IgnoreLayer {
  /** POSIX-relative directory this file governs ("" = repo root). */
  readonly baseDir: string;
  readonly rules: readonly CompiledRule[];
}

class MalformedPatternError extends Error {}

/** Escape one literal character for embedding in a regular expression. */
function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate an (already anchor-normalized) glob body into a regex source that
 * matches a path relative to its base directory. Throws
 * {@link MalformedPatternError} on an unterminated bracket class.
 */
function translateGlob(body: string): string {
  let re = "";
  const n = body.length;
  let i = 0;
  while (i < n) {
    const ch = body[i]!;
    if (ch === "*") {
      const isDouble = body[i + 1] === "*";
      if (isDouble) {
        const prevIsBoundary = i === 0 || body[i - 1] === "/";
        let j = i;
        while (body[j] === "*") j++;
        const nextIsBoundary = j >= n || body[j] === "/";
        if (prevIsBoundary && nextIsBoundary) {
          if (body[j] === "/") {
            // `**/` - zero or more leading path segments.
            re += "(?:[^/]+/)*";
            i = j + 1;
          } else {
            // trailing `**` - everything below (and the node itself).
            re += ".*";
            i = j;
          }
        } else {
          // `**` glued to a segment behaves like a single `*`.
          re += "[^/]*";
          i = j;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      let j = i + 1;
      if (body[j] === "!" || body[j] === "^") j++;
      if (body[j] === "]") j++; // a leading `]` is a literal member
      while (j < n && body[j] !== "]") j++;
      if (j >= n) throw new MalformedPatternError("unterminated character class");
      let cls = body.slice(i, j + 1);
      if (cls.startsWith("[!")) cls = `[^${cls.slice(2)}`;
      re += cls;
      i = j + 1;
    } else {
      re += escapeLiteral(ch);
      i++;
    }
  }
  return re;
}

/** Strip trailing whitespace that is not backslash-escaped (git semantics). */
function stripTrailingWhitespace(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    // A space is retained when the run of preceding backslashes is odd.
    let backslashes = 0;
    let k = end - 2;
    while (k >= 0 && line[k] === "\\") {
      backslashes++;
      k--;
    }
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/** Compile one non-comment, non-blank pattern line into a rule. */
function compileRule(rawPattern: string): CompiledRule {
  let pattern = rawPattern;
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  // Anchored when the pattern carries a leading or internal separator.
  const hasLeadingSlash = pattern.startsWith("/");
  if (hasLeadingSlash) pattern = pattern.slice(1);
  const anchored = hasLeadingSlash || pattern.includes("/");

  const translated = translateGlob(pattern);
  const source = anchored ? `^${translated}$` : `^(?:.*/)?${translated}$`;
  return { negated, dirOnly, re: new RegExp(source) };
}

/**
 * Parse one ignore file into a layer plus any malformed-pattern warnings.
 * `baseDir` is the POSIX-relative directory the file governs ("" = root).
 */
export function parseIgnoreLayer(
  content: string,
  baseDir: string,
  source: string,
): { layer: IgnoreLayer; warnings: IgnoreWarning[] } {
  const rules: CompiledRule[] = [];
  const warnings: IgnoreWarning[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = stripTrailingWhitespace(lines[index]!);
    if (raw.length === 0) continue;
    if (raw.startsWith("#")) continue; // `\#` was preserved by the strip above
    try {
      rules.push(compileRule(raw));
    } catch (err) {
      warnings.push({
        source,
        line: index + 1,
        pattern: raw,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { layer: { baseDir, rules }, warnings };
}

/** Parse a flat list of patterns (e.g. `--exclude` values) into a layer. */
export function parseIgnorePatterns(
  patterns: ReadonlyArray<string>,
  baseDir: string,
  source: string,
): { layer: IgnoreLayer; warnings: IgnoreWarning[] } {
  return parseIgnoreLayer(patterns.join("\n"), baseDir, source);
}

/** Path relative to `baseDir`, or null when `relPath` is not under it. */
function relativeToBase(baseDir: string, relPath: string): string | null {
  if (baseDir === "") return relPath;
  if (relPath === baseDir) return "";
  return relPath.startsWith(`${baseDir}/`) ? relPath.slice(baseDir.length + 1) : null;
}

/**
 * An ordered stack of ignore layers, lowest precedence first. Immutable:
 * {@link extend} returns a new scope so a tree walk can push a directory's
 * `.gitignore` for its subtree without mutating the parent's scope.
 */
export class IgnoreScope {
  private constructor(private readonly layers: readonly IgnoreLayer[]) {}

  static empty(): IgnoreScope {
    return new IgnoreScope([]);
  }

  /** Return a new scope with `layer` at the highest precedence. */
  extend(layer: IgnoreLayer): IgnoreScope {
    return new IgnoreScope([...this.layers, layer]);
  }

  /** True when no layer carries any rule (so nothing can be ignored). */
  get isEmpty(): boolean {
    return this.layers.every((layer) => layer.rules.length === 0);
  }

  /**
   * Whether `relPath` (repo-root-relative, POSIX) is ignored. `isDir` gates
   * directory-only rules. The last matching rule across all layers in
   * precedence order decides; a negated last match re-includes the path.
   */
  isIgnored(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    let matched = false;
    for (const layer of this.layers) {
      const sub = relativeToBase(layer.baseDir, relPath);
      if (sub === null || sub === "") continue;
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (!rule.re.test(sub)) continue;
        matched = true;
        ignored = !rule.negated;
      }
    }
    return matched && ignored;
  }
}
