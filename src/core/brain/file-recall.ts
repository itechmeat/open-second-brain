/**
 * File-context recall (Recall & Working-Memory Quality Suite,
 * t_4f420aca).
 *
 * Before an agent reads a file, it is useful to surface what the vault
 * already knows about that file - prior decisions, bug notes, refactor
 * history. This module answers that by querying the EXISTING search
 * index with terms derived structurally from the file path (basename,
 * stem, parent directory); no LLM, no natural-language processing. A
 * file-size gate skips trivial files, mirroring the mem0 source's
 * >= 1500-byte threshold, and returns an explicit reason rather than a
 * fabricated empty hit.
 *
 * Read-only: this never writes to the vault or the index.
 */

import { statSync } from "node:fs";

import { search } from "../search/search.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../search/types.ts";

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_BYTES = 1500;

export interface FileContextOptions {
  /** Path of the file the caller is about to read (absolute or relative). */
  readonly filePath: string;
  /** Maximum prior-work hits to return. Default 5. */
  readonly limit?: number;
  /** Skip files smaller than this many bytes. Default 1500. */
  readonly minBytes?: number;
}

export interface FileContextResult {
  readonly filePath: string;
  /** True when the gate (or an empty query) suppressed the search. */
  readonly skipped: boolean;
  /** Why the search was suppressed, or null when it ran. */
  readonly reason: string | null;
  /** The query terms derived from the path. */
  readonly query: string;
  readonly results: ReadonlyArray<BrainSearchResult>;
}

/**
 * Derive search terms from a file path, structurally: the basename and
 * its extensionless stem, de-duplicated and space-joined. Separator- and
 * language-agnostic, no word list. The parent directory is deliberately
 * excluded: keyword retrieval ANDs terms, so a directory name a note
 * does not mention would suppress an otherwise-relevant hit. The
 * basename is the canonical "this exact file" signal.
 */
export function deriveFileQuery(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").normalize("NFC").trim();
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "";
  const base = segments[segments.length - 1]!;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const unique: string[] = [];
  for (const term of [base, stem]) {
    if (term.length > 0 && !unique.includes(term)) unique.push(term);
  }
  return unique.join(" ");
}

/**
 * Surface prior vault work that mentions `filePath`. Returns an explicit
 * skip (with a reason) when the file is below the size gate or the path
 * yields no query terms; otherwise runs a read-only search and returns
 * its hits.
 */
export async function fileContextRecall(
  config: ResolvedSearchConfig,
  opts: FileContextOptions,
): Promise<FileContextResult> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? DEFAULT_LIMIT));
  const minBytes = Math.max(0, opts.minBytes ?? DEFAULT_MIN_BYTES);
  const query = deriveFileQuery(opts.filePath);

  if (query.length === 0) {
    return frozenResult(opts.filePath, true, "no_query_terms", query, []);
  }

  // Size gate: skip trivial files. Only applies when the file exists and
  // can be measured; a missing path (e.g. an external reference) still
  // searches, since the query is the path itself.
  const size = fileSize(opts.filePath);
  if (size !== null && size < minBytes) {
    return frozenResult(opts.filePath, true, "below_size_gate", query, []);
  }

  const outcome = await search(config, { query, limit });
  return frozenResult(opts.filePath, false, null, query, outcome.results);
}

function fileSize(filePath: string): number | null {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function frozenResult(
  filePath: string,
  skipped: boolean,
  reason: string | null,
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
): FileContextResult {
  return Object.freeze({
    filePath,
    skipped,
    reason,
    query,
    results: Object.freeze([...results]),
  });
}
