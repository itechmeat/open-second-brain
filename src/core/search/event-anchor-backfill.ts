/**
 * Event-anchor backfill (provenance at the boundary, t_ac1c4176).
 *
 * The v11 migration adds the anchor columns to an existing index IN
 * PLACE. A schema bump reindexes nothing - `applyMigrations` alters the
 * table and only a version newer than this binary refuses - and the
 * indexer resolves an anchor only below its two content-identity
 * fastpaths. Both of those are right for content: unchanged content can
 * only ever resolve to the same anchor, so declining to recompute cannot
 * stale it. Neither is right across a BINARY upgrade: a document indexed
 * by the previous binary has no anchor, its content never changes, and
 * so no run ever computes one. The feature is inert on every vault that
 * already existed, and the column now gates a hard `since` / `until`
 * filter.
 *
 * This module is the operator-facing way to close that gap without
 * re-walking, re-chunking or re-embedding the vault. It reads each
 * unexamined document's file, resolves the anchor with the SAME function
 * the indexer uses, and writes the four anchor columns on that row.
 * Nothing else on the row moves - not the stat fingerprint, not the
 * chunks, not the links - so a backfill cannot disturb the fastpaths.
 *
 * Contract, taken verbatim from `brain/authored-at-backfill.ts` and
 * `search/vector-backfill.ts`:
 *   - Dry-run by DEFAULT. {@link planEventAnchorBackfill} without `apply`
 *     opens the index read-only, counts, and writes nothing at all.
 *   - `apply` is the only mutating path.
 *   - Idempotent: an examined row is never re-examined, so a re-run over
 *     a backfilled index finds nothing pending and does nothing.
 *
 * A file that cannot be read is NAMED and left pending. The run does not
 * get to record "this note declares no date" for a note it never opened;
 * that is the exact conflation the examination marker exists to prevent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatterText } from "../vault.ts";
import { resolveEventAnchor } from "./event-anchor.ts";
import { Store } from "./store.ts";
import type { ResolvedSearchConfig } from "./types.ts";

export interface EventAnchorBackfillOptions {
  /** When true, resolve and store the missing anchors. Default false. */
  readonly apply?: boolean;
}

/** One indexed document whose file the run could not read. */
export interface UnreadableDocument {
  /** Vault-relative POSIX path, as the index holds it. */
  readonly path: string;
  readonly message: string;
}

export interface EventAnchorBackfillResult {
  /** Whether the run mutated the index (`false` for a dry run). */
  readonly applied: boolean;
  /** Documents in the index. */
  readonly documentsTotal: number;
  /** Documents no anchor-aware binary had examined when the run started. */
  readonly pending: number;
  /** Documents this run read and resolved an answer for (0 on a dry run). */
  readonly examined: number;
  /**
   * Of those, the ones that turned out to DECLARE a date. The remainder
   * declare none - which is now a recorded verdict rather than an
   * unexamined row.
   */
  readonly anchored: number;
  /** Indexed documents whose file could not be read; each stays pending. */
  readonly unreadable: ReadonlyArray<UnreadableDocument>;
}

/**
 * Count the documents no anchor-aware binary has examined and, when
 * `apply` is set, examine them.
 *
 * Throws `SearchError("INDEX_MISSING")` from {@link Store.open} when
 * there is no index to read: an absent index is a different answer from
 * an index with nothing pending, and collapsing the two would report
 * "nothing to do" for a vault that has never been indexed.
 */
export async function planEventAnchorBackfill(
  config: ResolvedSearchConfig,
  opts: EventAnchorBackfillOptions = {},
): Promise<EventAnchorBackfillResult> {
  const apply = opts.apply === true;
  const store = await Store.open(config, { mode: apply ? "write" : "read" });
  try {
    const pending = store.unexaminedEventAnchorPaths();
    const documentsTotal = store.counts().documents;
    const unreadable: UnreadableDocument[] = [];
    let examined = 0;
    let anchored = 0;

    if (apply) {
      for (const path of pending) {
        let content: string;
        try {
          content = readFileSync(join(config.vault, path), "utf8");
        } catch (err) {
          unreadable.push(
            Object.freeze({ path, message: err instanceof Error ? err.message : String(err) }),
          );
          continue;
        }
        const [frontmatter, body] = parseFrontmatterText(content);
        const anchor = resolveEventAnchor(frontmatter as Record<string, unknown>, body);
        store.setEventAnchor(path, anchor);
        examined++;
        if (anchor !== null) anchored++;
      }
    }

    return Object.freeze({
      applied: apply,
      documentsTotal,
      pending: pending.length,
      examined,
      anchored,
      unreadable: Object.freeze(unreadable),
    });
  } finally {
    await store.close();
  }
}
