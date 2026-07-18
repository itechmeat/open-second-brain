/**
 * Extractable-flag gate for page discovery (P3, t_ed856388).
 *
 * The schema pack already stores an `extractable` allowlist of schema tokens
 * (set via the `set_extractable` mutation), but nothing consulted it during
 * discovery. This gate does: when the allowlist is non-empty, a discovered page
 * whose declared `schema_type` is NOT in it is skipped before extraction and
 * reported with a reason, rather than silently ingested.
 *
 * Semantics (documented judgment calls):
 *   - an EMPTY allowlist gates nothing, so discovery is byte-identical to
 *     before the flag was honored (opt-out by default);
 *   - a page with no `schema_type` frontmatter belongs to no pack and stays
 *     ungated (kept) - raw untyped sources are never dropped by this gate.
 *
 * Pure and read-only: it reads frontmatter and returns a partition; it mutates
 * no schema surface.
 */

import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { loadSchemaPack } from "../schema-pack.ts";

/** The frontmatter field that carries a page's schema page-type token. */
const PAGE_TYPE_FIELD = "schema_type";

/** One page skipped by the gate, with the reason it was excluded. */
export interface SkippedPage {
  readonly path: string;
  readonly reason: string;
}

/** Discovered pages split into the extractable set and the skipped set. */
export interface ExtractablePartition {
  readonly extractable: string[];
  readonly skipped: SkippedPage[];
}

/**
 * The set of schema tokens declared extractable for `vault`. An empty set means
 * the gate is inactive (no `extractable` declaration).
 */
export function extractableAllowlist(vault: string): ReadonlySet<string> {
  return new Set(loadSchemaPack(vault).extractable);
}

/** A page's declared `schema_type` token, or null when it has none. */
function pageType(vault: string, relPath: string): string | null {
  try {
    const [meta] = parseFrontmatter(join(vault, relPath));
    const raw = meta[PAGE_TYPE_FIELD];
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    // An unreadable/parseless page has no declared type; leave it ungated.
    return null;
  }
}

/**
 * Partition `relPaths` (vault-relative, in their given order) into pages that
 * pass the extractable gate and pages skipped-with-reason. An empty `allowlist`
 * keeps everything.
 */
export function partitionExtractable(
  vault: string,
  relPaths: readonly string[],
  allowlist: ReadonlySet<string>,
): ExtractablePartition {
  if (allowlist.size === 0) {
    return { extractable: [...relPaths], skipped: [] };
  }
  const extractable: string[] = [];
  const skipped: SkippedPage[] = [];
  for (const path of relPaths) {
    const type = pageType(vault, path);
    if (type === null || allowlist.has(type)) {
      extractable.push(path);
      continue;
    }
    skipped.push({
      path,
      reason: `schema_type "${type}" is not in the schema extractable allowlist`,
    });
  }
  return { extractable, skipped };
}
