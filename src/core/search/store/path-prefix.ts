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
 * path in Unicode NFC, compared under BINARY collation:
 *
 *   - every path under `prefix` sorts at or after `lo = prefix` and
 *     strictly before `hi = prefix || U+FFFF` (U+FFFF is the largest
 *     code point and a noncharacter, so it cannot occur inside a stored
 *     path - any continuation character sorts below it);
 *   - any path that is not under `prefix` either sorts below `lo` or has
 *     a divergent character within the prefix, which sorts against
 *     U+FFFF above the bound.
 *
 * This is the same row set the `substr` form returned, which the prefix
 * tests pin by running both forms against one store.
 */

import { canonicalNotePath } from "../../path-safety.ts";

/**
 * The exclusive upper bound appended to a canonical prefix. A noncharacter
 * that cannot appear in an NFC note path, so no sibling path can slip
 * under it and no prefixed path can escape over it.
 */
const PREFIX_RANGE_BOUND = "\uFFFF";

/** The inclusive lower and exclusive upper bounds of one path prefix. */
export interface PathPrefixRange {
  readonly lo: string;
  readonly hi: string;
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
  return { lo: canonical, hi: canonical + PREFIX_RANGE_BOUND };
}
