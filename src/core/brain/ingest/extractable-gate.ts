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

/**
 * Why a page was skipped before extraction. A closed token union (the
 * `PAGE_LINT_SKIP_REASON` pattern): the reason crosses the MCP wire and the
 * CLI JSON verbatim, so a reader must be able to reject a value this build
 * does not understand instead of parsing free text.
 */
export const SKIPPED_PAGE_REASON = Object.freeze({
  /**
   * The file's format is one the source format registry names but has no
   * extractor for (PDF, Office, EPUB, RTF, images); `detail` is the format.
   */
  formatNotExtractable: "format-not-extractable",
  /** The page's `schema_type` is not in the schema `extractable` allowlist. */
  notExtractable: "schema-type-not-extractable",
} as const);

/** The closed union of skip reason tokens. */
export type SkippedPageReason = (typeof SKIPPED_PAGE_REASON)[keyof typeof SKIPPED_PAGE_REASON];

/** Membership list of the closed union, in the order a page meets the gates. */
export const SKIPPED_PAGE_REASONS: ReadonlyArray<SkippedPageReason> = Object.freeze([
  SKIPPED_PAGE_REASON.formatNotExtractable,
  SKIPPED_PAGE_REASON.notExtractable,
]);

/** The free-text sentence this gate emitted before the reason was typed (P4). */
const LEGACY_REASON_RE = /^schema_type "[^"]*" is not in the schema extractable allowlist$/;

/**
 * Membership guard of the closed union: true only for a token this build
 * emits. The legacy free-text sentence is NOT a member, so it is rejected
 * here; a reader of persisted or wire values uses
 * {@link parseSkippedPageReason}, which maps it to its token.
 */
export function isSkippedPageReason(value: unknown): value is SkippedPageReason {
  return (
    typeof value === "string" && (SKIPPED_PAGE_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Parse a reason read back across a tool boundary. Accepts the typed token
 * and the legacy free-text sentence pre-taxonomy builds serialized - that
 * sentence was the only reason this gate ever emitted, so it maps to
 * {@link SKIPPED_PAGE_REASON.notExtractable} - and returns null for
 * anything else, so a caller never misreads a value it does not understand.
 */
export function parseSkippedPageReason(value: unknown): SkippedPageReason | null {
  if (isSkippedPageReason(value)) return value;
  if (typeof value === "string" && LEGACY_REASON_RE.test(value)) {
    return SKIPPED_PAGE_REASON.notExtractable;
  }
  return null;
}

/** One page skipped by the gate, with the reason it was excluded. */
export interface SkippedPage {
  readonly path: string;
  /** Typed reason token from the closed {@link SKIPPED_PAGE_REASONS} union. */
  readonly reason: SkippedPageReason;
  /**
   * The value behind the skip - the page's declared `schema_type`, or the
   * `SourceFormat` token of a format skip - so the reason is checkable
   * without re-reading the page (the page-lint `detail` pattern:
   * identifiers cross the boundary, never prose).
   */
  readonly detail: string;
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
    skipped.push({ path, reason: SKIPPED_PAGE_REASON.notExtractable, detail: type });
  }
  return { extractable, skipped };
}
