/**
 * The query side of forgetting (`forgotten.ts`): a store record a search
 * ranked is shown only when the ingest would hold it.
 *
 * The index leaves forgotten and staged records out when it ingests and
 * takes them out when a catch-up meets their tombstone, mark or staging,
 * but between a catch-up's commits and its end-of-pass fold, between two
 * catch-ups, and on an index built by an older binary, it can still hold
 * one. So every ranked record of a fold the forgetting reads (a signal's,
 * a preference's, a lane entry's, their tombstones included) is checked
 * against the same rule over the store as it is now
 * (`storeRecordVisibility`, cached until an `events` shard changes): it
 * stays only when the store holds it whole and the rule does not hide it.
 * Everything not known to be visible fails closed: a store that cannot be
 * read, a record row that cannot be looked up, a body still pending, a
 * record the store no longer holds.
 *
 * A log event is shown unless it references a forgotten record itself
 * (`forgotten.ts`, `namesForgottenEntity`: its id, its page path or a
 * link to it, never a bare word it shares with one): the record the user
 * forgot must not stay findable through the events that name it. When
 * the store cannot be read, a log event fails closed like a fold record.
 *
 * Records of every other kind (decisions, topics, ledger rows) pass: no
 * tombstone, mark or approval applies to them.
 */

import type { Store } from "../store.ts";
import { getRecord } from "../store/brain-records.ts";
import { storeRecordVisibility, type StoreVisibility } from "./catch-up.ts";
import { LOG_EVENT_KIND, STORE_PARTITIONS } from "../../store/constants.ts";
import { isStoreRecordPath, STORE_RECORD_PATH_PREFIX } from "./constants.ts";
import { isForgettingFoldKind, namesForgottenEntity, noForgottenRefs } from "./forgotten.ts";

/** The record id of a store record path (`.brain-store/<partition>/<id>`). */
function recordIdOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A judge of single store record paths over one index, reading the
 * store's visibility at most once: true for a path that is no store
 * record, and for a store record the ingest would hold.
 */
export function storeRecordJudge(index: Store): (path: string) => boolean {
  let visibility: StoreVisibility | null | undefined;
  const visible = (): StoreVisibility | null => {
    if (visibility !== undefined) return visibility;
    const store = index.indexedBrainStore();
    visibility = store === null ? null : storeRecordVisibility(store);
    return visibility;
  };
  const db = index.brainRecordsConnection();
  return (path: string): boolean => {
    if (!isStoreRecordPath(path)) return true;
    const id = recordIdOf(path);
    let kind: string;
    let documentId: number | null;
    try {
      const row = getRecord(db, id);
      if (row === null) return false;
      kind = row.kind;
      documentId = row.documentId;
    } catch {
      return false;
    }
    if (kind === LOG_EVENT_KIND) {
      const v = visible();
      if (v === null) return false;
      if (noForgottenRefs(v.hiddenRefs) || documentId === null) return true;
      try {
        const text = index
          .getChunksByDocument(documentId)
          .map((c) => c.content)
          .join("\n");
        return !namesForgottenEntity(text, v.hiddenRefs);
      } catch {
        return false;
      }
    }
    if (!isForgettingFoldKind(kind)) return true;
    const v = visible();
    return v !== null && v.known.has(id) && !v.hidden.has(id);
  };
}

/**
 * `ranked` without the store records the ingest would not hold (see the
 * module docblock). The same array when no row is a store record.
 */
export function applyStoreEntityFilter<
  T extends {
    readonly path: string;
    readonly duplicates?: ReadonlyArray<{ readonly path: string }>;
  },
>(ranked: ReadonlyArray<T>, index: Store): ReadonlyArray<T> {
  const named = (r: T): boolean =>
    isStoreRecordPath(r.path) || (r.duplicates ?? []).some((d) => isStoreRecordPath(d.path));
  if (!ranked.some(named)) return ranked;
  const shown = storeRecordJudge(index);
  const out: T[] = [];
  for (const row of ranked) {
    if (!shown(row.path)) continue;
    // The exact duplicates folded into a visible row are locations the
    // answer names too: a hidden record among them is dropped from the
    // row, which itself stays.
    const duplicates = row.duplicates;
    if (duplicates === undefined || duplicates.length === 0) {
      out.push(row);
      continue;
    }
    const kept = duplicates.filter((d) => shown(d.path));
    if (kept.length === duplicates.length) {
      out.push(row);
      continue;
    }
    const { duplicates: _dropped, ...rest } = row;
    out.push(
      (kept.length > 0 ? { ...rest, duplicates: Object.freeze(kept) } : rest) as unknown as T,
    );
  }
  return out;
}

/** A store record path anywhere in a string (a path, a `path:Lstart-Lend` pointer, a prompt). */
const STORE_RECORD_PATH_IN_TEXT_RE = new RegExp(
  `${STORE_RECORD_PATH_PREFIX.replace(".", "\\.")}/(?:${STORE_PARTITIONS.join("|")})/[0-9A-Za-z]+`,
  "g",
);

/** Every store record path any string below `value` names. */
function storeRecordPathsIn(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 32) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(STORE_RECORD_PATH_IN_TEXT_RE)) out.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) storeRecordPathsIn(item, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) storeRecordPathsIn(item, out, depth + 1);
  }
}

/**
 * Whether a precomputed answer (a persistent query-cache row) may still be
 * served: every store record it names, in any field and any shape (results,
 * cards and their duplicate pointers, an evidence pack's records, dropped
 * candidates and union records, an iterative plan's prompt, a trace), and
 * every chunk id it hands the caller to come back with (`chunkIds`: an
 * iterative plan's pool), is a record the store rule still shows. Walked
 * generically rather than field by field, so a shape added later is
 * covered without a change here.
 */
export function precomputedAnswerAdmitted(
  outcome: unknown,
  index: Store,
  chunkIds: ReadonlyArray<number> = [],
): boolean {
  const paths = new Set<string>();
  storeRecordPathsIn(outcome, paths);
  if (chunkIds.length > 0) {
    const wanted = new Set(chunkIds);
    const hits = index.hydrateChunks([...wanted]);
    // A chunk id the index no longer holds names a record gone since: the
    // plan would hand the caller an id nothing answers for.
    if (hits.size < wanted.size) return false;
    for (const hit of hits.values()) paths.add(hit.path);
  }
  if (paths.size === 0) return true;
  const shown = storeRecordJudge(index);
  for (const path of paths) if (!shown(path)) return false;
  return true;
}
