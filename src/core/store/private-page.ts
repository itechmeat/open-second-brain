/**
 * The one rule that decides whether a page (or a record carrying a page's
 * frontmatter) is private: the reserved `visibility` token, or an informal
 * marker such as `access: private`, as search and remote reads judge it
 * (`graph/privacy-markers.ts`). A leaf, so the dual-write builders, the
 * reference judge and the store-backed read facades share it without
 * importing each other.
 */

import { remoteDenyVisibilityTokens } from "../graph/privacy-markers.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatterWithNotices } from "../vault.ts";

/**
 * Whether a page's frontmatter reserves it as private, by the same rule
 * search and remote reads use: the reserved `visibility` token, or an
 * informal marker such as `access: private` (`graph/privacy-markers.ts`).
 * Such a page's records go to the `private` partition.
 */
export function isPrivateFrontmatter(frontmatter: Readonly<Record<string, unknown>>): boolean {
  return remoteDenyVisibilityTokens(frontmatter as FrontmatterMap).includes(
    REMOTE_DENY_VISIBILITY_TOKEN,
  );
}

/**
 * {@link isPrivateFrontmatter} for a page on disk. Every brain writer that
 * decides a record's partition from a file goes through here, so one rule
 * decides privacy everywhere. A file that exists but cannot be read or
 * parsed counts as private, the partition that leaks nothing.
 */
export function isPrivatePageFile(path: string): boolean {
  // The parser reports a failed read as a notice with an empty map, which
  // would read as open, so the notice is what decides here.
  const [frontmatter, , notices] = parseFrontmatterWithNotices(path);
  if (notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable)) return true;
  return isPrivateFrontmatter(frontmatter);
}
