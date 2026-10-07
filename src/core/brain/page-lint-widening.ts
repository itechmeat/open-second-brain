/**
 * Keyword-index widening for the write-receipt near-duplicate hint.
 *
 * The receipt hint in `page-lint.ts` compares a written page only with the
 * pages in its own directory, because that walk reads the disk and must
 * stay bounded. A paraphrase usually lands somewhere else. This module
 * widens the candidate set through the search index that already exists:
 *
 *   1. the written body's longest {@link WIDENING_QUERY_MAX_TERMS} distinct
 *      tokens become one FTS5 OR query through `buildFtsMatch`; the
 *      candidates are still scored on the full token set;
 *   2. `keywordTopK` pulls the BM25 top {@link NEAR_DUPLICATE_WIDENING_TOP_K}
 *      chunks of other pages per written page (the page's own indexed
 *      chunks are excluded), so one call reads at most that many
 *      candidate pages per page it wrote;
 *   3. each hit maps to its document path, the caller's `readable`
 *      predicate drops a withheld page before anything else happens, and
 *      the page is re-read from disk, so a page deleted since the last
 *      index pass, or one changed since, cannot produce a stale hint;
 *   4. every page is projected into a {@link NearDuplicateCandidate} for
 *      the lint to score through the shared kernel.
 *
 * Zero embedding spend by construction: nothing here imports from
 * `src/core/search/embeddings/`. The store is opened read-only and is
 * never repaired from here (the FTS rebuild path takes the writer lock).
 *
 * Fail-open, never silent: an index that cannot be opened, queried or
 * closed, and any other throw on the way to the candidates, yields the
 * named status `index_unavailable` and no candidates, so the
 * write and the same-directory hint are unaffected and the receipt says
 * the widening did not run. The status carries the failure by name
 * (`detail`), so a missing index, a locked or corrupt one and a defect in
 * this module read differently on the receipt.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { vaultRelative } from "../path-safety.ts";
import { compositeScopeKey, scopeFromFrontmatter } from "../scope-key.ts";
import { buildFtsMatch } from "../search/fts.ts";
import { FTS_MATCH_MODE } from "../search/fts-match-mode.ts";
import { Store } from "../search/store.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";
import { parseFrontmatterText } from "../vault.ts";
import { NEAR_DUPLICATE_WIDENING_TOP_K, type ReadableRef } from "./near-duplicate.ts";
import {
  failureCode,
  type NearDuplicateCandidate,
  type NearDuplicateWideningStatus,
} from "./page-lint.ts";
import { tokenise } from "./similarity.ts";
import { ARTIFACT_MAX_BYTES } from "./write-session/validate.ts";

export interface WideningResult {
  readonly status: NearDuplicateWideningStatus;
  readonly candidates: ReadonlyArray<NearDuplicateCandidate>;
  /**
   * Why the status is `index_unavailable`: the search error code, the
   * errno code or the error name, never a message or a path. Absent when
   * the index answered.
   */
  readonly detail?: string;
}

/** Extension every candidate page on disk carries. */
const MARKDOWN_EXT = ".md";

/** Prefix of a vault-relative spelling that leaves the vault. */
const VAULT_ESCAPE_PREFIX = "../";

/**
 * Most distinct tokens one widening query OR-joins. FTS5 cost grows with
 * the term count and a written page may be up to the artifact byte cap,
 * so the query is bounded; the hint's quality does not depend on it,
 * because the lint scores every candidate on the full token set.
 */
export const WIDENING_QUERY_MAX_TERMS = 64;

/** The fail-open answer for a widening that could not run, naming why. */
export function wideningUnavailable(err: unknown): WideningResult {
  return Object.freeze({
    status: "index_unavailable",
    candidates: Object.freeze([]),
    detail: failureCode(err),
  });
}

/** The vault-relative spelling of a page, the one `page-lint.ts` reports. */
function canonicalPage(vault: string, page: string): string {
  return vaultRelative(resolve(vault, page), vault);
}

/**
 * The page on disk as a candidate, or `null` when it provides no evidence:
 * outside the vault, not Markdown, gone since the index saw it, over the
 * artifact byte cap, or unreadable. The index is a hint about where to
 * look, not evidence; the same-directory walk in `page-lint.ts` is the
 * surface that names an unreadable sibling.
 */
function readCandidate(vault: string, page: string): NearDuplicateCandidate | null {
  if (page.startsWith(VAULT_ESCAPE_PREFIX) || !page.endsWith(MARKDOWN_EXT)) return null;
  const absolute = resolve(vault, page);
  try {
    if (statSync(absolute).size > ARTIFACT_MAX_BYTES) return null;
    const [meta, body] = parseFrontmatterText(readFileSync(absolute, "utf8"));
    return Object.freeze({
      page,
      scopeKey: compositeScopeKey(scopeFromFrontmatter(meta)),
      tokens: tokenise(body),
    });
  } catch {
    return null;
  }
}

/**
 * The FTS5 query for one written page: its distinct body tokens, OR-joined,
 * capped at {@link WIDENING_QUERY_MAX_TERMS} by the longest-first rule.
 * Longest first, ties in code-unit order: a long token is the rarer one
 * in practice and needs no index read to rank, and the order is total, so
 * the same body always yields the same query.
 */
function widenQuery(vault: string, page: string): string {
  const candidate = readCandidate(vault, page);
  if (candidate === null) return "";
  const terms = [...candidate.tokens]
    .toSorted((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, WIDENING_QUERY_MAX_TERMS);
  return buildFtsMatch(terms.join(" "), { matchMode: FTS_MATCH_MODE.any });
}

/**
 * Vault-relative paths of the documents behind the top keyword hits, in hit
 * order. The written page's own indexed chunks are excluded by document id:
 * its query is built from its own tokens, so on an update its older chunks
 * would otherwise be the strongest matches and fill every slot. The pull
 * grows by exactly that page's chunk count, so the top-k still counts
 * other pages only.
 */
function keywordPaths(store: Store, query: string, page: string): ReadonlyArray<string> {
  const ownId = store.getDocumentIdByPath(page);
  const ownChunks = ownId === null ? 0 : store.chunksForDocument(ownId).length;
  const hits = store
    .keywordTopK(query, { limit: NEAR_DUPLICATE_WIDENING_TOP_K + ownChunks })
    .filter((hit) => hit.documentId !== ownId)
    .slice(0, NEAR_DUPLICATE_WIDENING_TOP_K);
  const hydrated = store.hydrateChunks(hits.map((hit) => hit.chunkId));
  const paths: string[] = [];
  for (const hit of hits) {
    const chunk = hydrated.get(hit.chunkId);
    if (chunk !== undefined) paths.push(chunk.path);
  }
  return paths;
}

/**
 * Near-duplicate candidates from the keyword index for the pages one write
 * committed. Each candidate appears once, in first-hit order, whatever
 * number of chunks or written pages pulled it in.
 *
 * Never throws: the write it hints on has already happened, so a failure
 * anywhere - opening, querying or closing the store, the `readable`
 * predicate, a candidate read - is the named `index_unavailable` status,
 * never an error the caller would read as a failed write and retry.
 */
export async function collectWideningCandidates(
  config: ResolvedSearchConfig,
  vault: string,
  pages: ReadonlyArray<string>,
  readable: ReadableRef,
): Promise<WideningResult> {
  try {
    return await widen(config, vault, pages, readable);
  } catch (err) {
    return wideningUnavailable(err);
  }
}

async function widen(
  config: ResolvedSearchConfig,
  vault: string,
  pages: ReadonlyArray<string>,
  readable: ReadableRef,
): Promise<WideningResult> {
  const store = await Store.open(config, { mode: "read" });
  const hitPaths: string[] = [];
  try {
    for (const page of pages) {
      const written = canonicalPage(vault, page);
      const query = widenQuery(vault, written);
      if (query === "") continue;
      hitPaths.push(...keywordPaths(store, query, written));
    }
  } finally {
    await store.close();
  }
  const seen = new Set<string>();
  const candidates: NearDuplicateCandidate[] = [];
  for (const hitPath of hitPaths) {
    const page = canonicalPage(vault, hitPath);
    if (seen.has(page)) continue;
    seen.add(page);
    // Reach first: a withheld page is never read, so it cannot be returned.
    if (!readable(page)) continue;
    const candidate = readCandidate(vault, page);
    if (candidate !== null) candidates.push(candidate);
  }
  return Object.freeze({ status: "used", candidates: Object.freeze(candidates) });
}
