/**
 * Keyword-index widening for the write-receipt near-duplicate hint.
 *
 * The receipt hint in `page-lint.ts` compares a written page only with the
 * pages in its own directory, because that walk reads the disk and must
 * stay bounded. A paraphrase usually lands somewhere else. This module
 * widens the candidate set through the search index that already exists:
 *
 *   1. the written body's distinct tokens become one FTS5 OR query through
 *      `buildFtsMatch`;
 *   2. `keywordTopK` pulls the BM25 top {@link NEAR_DUPLICATE_WIDENING_TOP_K}
 *      chunks per written page, so one call reads at most that many
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
 * Fail-open, never silent: an index that cannot be opened or queried
 * yields the named status `index_unavailable` and no candidates, so the
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

/** The FTS5 query for one written page: its distinct body tokens, OR-joined. */
function widenQuery(vault: string, page: string): string {
  const candidate = readCandidate(vault, page);
  if (candidate === null) return "";
  return buildFtsMatch([...candidate.tokens].join(" "), { matchMode: FTS_MATCH_MODE.any });
}

/** Vault-relative paths of the documents behind the top keyword hits, in hit order. */
function keywordPaths(store: Store, query: string): ReadonlyArray<string> {
  const hits = store.keywordTopK(query, { limit: NEAR_DUPLICATE_WIDENING_TOP_K });
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
 */
export async function collectWideningCandidates(
  config: ResolvedSearchConfig,
  vault: string,
  pages: ReadonlyArray<string>,
  readable: ReadableRef,
): Promise<WideningResult> {
  let store: Store;
  try {
    store = await Store.open(config, { mode: "read" });
  } catch (err) {
    return wideningUnavailable(err);
  }
  const hitPaths: string[] = [];
  try {
    for (const page of pages) {
      const query = widenQuery(vault, canonicalPage(vault, page));
      if (query === "") continue;
      hitPaths.push(...keywordPaths(store, query));
    }
  } catch (err) {
    return wideningUnavailable(err);
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
