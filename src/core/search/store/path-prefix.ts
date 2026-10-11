/**
 * The sargable path-prefix predicate (recall-quality, C1).
 *
 * Every prefixed read binds the same range form,
 * `path >= lo AND path < hi`, instead of the historical
 * `substr(path, 1, length(?)) = ?` expression. The `substr` form cannot
 * use `idx_documents_path` - SQLite evaluates it per row - while the
 * range form is answered by the b-tree as a scan over exactly the
 * matching rows.
 *
 * The bounds are exact because `documents.path` is a vault-relative POSIX
 * path in Unicode NFC, compared under BINARY collation - a byte-wise
 * comparison of the UTF-8 encodings:
 *
 *   - `lo` is the canonical prefix itself; every path under it sorts at
 *     or after `lo`;
 *   - `hi` is the canonical prefix with its LAST CODE POINT incremented
 *     by one. Every string starting with the prefix agrees with `hi`
 *     through the first n-1 code points and then holds the old code
 *     point where `hi` holds the incremented one, so it sorts STRICTLY
 *     below `hi` whatever continuation follows; and `hi` itself does not
 *     start with the prefix, so the bound is tight.
 *
 * A `prefix || U+FFFF` bound is NOT exact under this collation and was
 * the recall defect this module fixes: an astral continuation (an emoji
 * filename, U+1F300..U+10FFFF) encodes with a leading byte above
 * U+FFFF's 0xEF, sorts ABOVE that bound, and silently vanished from
 * every prefixed read the `substr` form still matched.
 *
 * When the last code point is U+10FFFF it cannot increment - but no code
 * point sorts ABOVE U+10FFFF either, so the bound stays exact by
 * incrementing the last incrementable code point BEFORE the trailing run
 * of U+10FFFFs instead: paths under the prefix hold that code point where
 * the bound holds its increment (strictly below), a path diverging
 * earlier above the prefix's own code point sorts above the bound, and a
 * path diverging inside the U+10FFFF run cannot exceed U+10FFFF at all.
 * Only when the prefix is empty or ENTIRELY U+10FFFFs does no exclusive
 * bound exist: `hi` is then `null` and the read must run as a
 * LOWER-BOUND-ONLY scan - `path >= lo` with no upper clause, correct for
 * every row under the prefix, merely wider. Every caller in this module
 * honours that contract: omit the `path < ?` clause exactly when `hi` is
 * null, never bind a stand-in string for it (`path < NULL` matches
 * nothing). The increment also skips the surrogate range (U+D7FF steps
 * to U+E000) so the bound is always a well-encoded, storable string.
 */

import { canonicalNotePath } from "../../path-safety.ts";

/** The inclusive lower and exclusive upper bounds of one path prefix. */
export interface PathPrefixRange {
  readonly lo: string;
  /**
   * The exclusive upper bound, or `null` when the prefix's last code
   * point is U+10FFFF (or the prefix is empty) and no exclusive bound
   * exists: run the read lower-bound-only.
   */
  readonly hi: string | null;
}

/**
 * The exclusive upper bound of the strings starting with `prefix`, or
 * null when no bound exists. Operates on code points, never UTF-16
 * units - the last character may be astral. A trailing run of U+10FFFF
 * code points cannot increment, so the increment lands on the last code
 * point BEFORE the run (still exact - see the module header); the
 * surrogate range is skipped (U+D7FF steps to U+E000) so the result
 * always encodes standalone. An empty or all-U+10FFFF prefix has no
 * bound.
 */
function prefixUpperBound(prefix: string): string | null {
  const points = [...prefix];
  let at = points.length - 1;
  while (at >= 0 && (points[at]!.codePointAt(0) ?? 0) >= 0x10ffff) at--;
  if (at < 0) return null;
  const code = points[at]!.codePointAt(0) ?? 0;
  const next = code === 0xd7ff ? 0xe000 : code + 1;
  return [...points.slice(0, at), String.fromCodePoint(next)].join("");
}

/**
 * Canonicalize a caller's path prefix and derive its range bounds.
 *
 * The caller may name a subtree with Windows separators - an MCP client on
 * a Windows host talks about the same vault the stored POSIX paths name -
 * so the separator convention is normalized first, and the result passes
 * through `canonicalNotePath` (POSIX form + NFC), the same identity every
 * stored path was written under. A literal backslash can no longer be
 * prefix-matched; stored paths are note identities, which never carry one.
 */
export function pathPrefixRange(prefix: string): PathPrefixRange {
  const canonical = canonicalNotePath(prefix.split("\\").join("/"));
  return { lo: canonical, hi: prefixUpperBound(canonical) };
}
