/**
 * Dead-weight utilization fold (recall-quality, t_1ee67e5b).
 *
 * The complement of retrieval, folded from artifacts that already exist:
 *
 *   - FULL SET - the vault walk's included `.md` pages
 *     (`walkVaultScopePaths` over the vault's own resolved scope), the
 *     population recall can currently return. The LIVE walk is the
 *     denominator on purpose: a page deleted on disk but still present
 *     in a stale index must not be reported as dead weight - deleting a
 *     note is maintenance, not a utilization problem - and a vanished
 *     path named inside a telemetry record counts as neither retrieved
 *     nor dead.
 *   - RETRIEVED SET - the union of `recall_telemetry`
 *     `payload.top_artifacts[].path` (mirrored in the record's
 *     `sourceRefs`) and `recall_observed_use` `sourceRefs[].path`, the
 *     two surfaces that record what recall actually surfaced.
 *   - DEAD - full minus retrieved: pages no recorded recall ever
 *     surfaced.
 *
 * HONESTY CONTRACT. Telemetry is opt-in (gate off by default) and
 * records only the surfaced top rows per query, so "dead" is provable
 * only as "never surfaced in recorded history within the window". The
 * report therefore states the observation window from the caller's
 * view-filtered record set - the earliest and latest `createdAt` among
 * the matched records the caller's reach view admits (a record whose
 * every surfaced path is hidden cannot widen or shift the window; the
 * log has no retention policy, so records begin where recording began)
 * - and carries {@link DEAD_WEIGHT_GATE_CAVEAT} verbatim. It never
 * claims "never read".
 *
 * READ-ONLY AND DETERMINISTIC. The fold emits nothing, writes nothing,
 * consults no clock, and two runs over the same inputs return equal
 * reports (path lists sorted, window bounds min/max over matched
 * records). Emission policy belongs to the surfaces above this fold.
 */

import { basename, isAbsolute, relative, sep } from "node:path";

import { canonicalNotePath } from "../path-safety.ts";
import { resolveVaultScope, walkVaultScopePaths } from "../vault-scope/index.ts";
import { listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";

/** What the report can and cannot claim, carried on every report. */
export const DEAD_WEIGHT_GATE_CAVEAT =
  "telemetry is opt-in and records only the surfaced top rows; " +
  "dead means never surfaced in recorded recall history within the window, not never read";

/**
 * The default cap on the `dead` path preview. `dead_count` is always the
 * exact complement size; the preview exists so a large vault answers
 * with a readable list instead of every quiet page at once.
 */
export const DEAD_WEIGHT_DEFAULT_LIMIT = 50;

/**
 * The cap on a caller-raised preview limit (PR #248 review L10): both
 * surfaces (the MCP `dead_weight` op and the CLI subcommand) clamp their
 * limit here, so the full list is reachable in bounded pages without one
 * unbounded request. Shared, so the two surfaces cannot drift.
 */
export const DEAD_WEIGHT_MAX_LIMIT = 500;

export interface DeadWeightOptions {
  /** Inclusive lower bound on the `createdAt` of the records folded. */
  readonly since?: string;
  /** Inclusive upper bound on the `createdAt` of the records folded. */
  readonly until?: string;
  /** Cap on the `dead` path preview (default {@link DEAD_WEIGHT_DEFAULT_LIMIT}). */
  readonly deadLimit?: number;
  /**
   * The caller's visibility boundary over the FULL SET, bound by the
   * surface above this fold (the tool layer's requestRefView /
   * gatedOwnerScopeView composition). Applied to the walked population
   * BEFORE any count, so a hidden page is dropped from `pages_total`,
   * `dead` and every count in the same stroke - a total that still
   * included the hidden rows would leak their number, the analytics
   * rule - and to the record set BEFORE the window, so a record whose
   * every surfaced path is hidden cannot widen or shift the reported
   * window either. Absent (a local caller, the owner) keeps every walked
   * page and every record.
   */
  readonly includePath?: (rel: string) => boolean;
}

export interface DeadWeightReport {
  /**
   * The observation window the fold actually covered, read off the
   * matched records the caller's view admits (earliest `createdAt`,
   * latest `createdAt` - a record surfaced only hidden paths cannot
   * shape it). Both null when no record matched: with no telemetry
   * history there is no window to state.
   */
  readonly window: { readonly since: string | null; readonly until: string | null };
  /** Pages currently in scope (the live `.md` population of the walk). */
  readonly pages_total: number;
  /** Of those, the pages some matching record surfaced at least once. */
  readonly pages_retrieved: number;
  /** `pages_total - pages_retrieved` - the exact complement size. */
  readonly dead_count: number;
  /** Path-sorted preview of the complement, capped at the limit. */
  readonly dead: ReadonlyArray<{ readonly path: string }>;
  /**
   * Surfaced entries that name no walked page: an id-only reference whose
   * stem matches nothing (or matches two pages, which the fold refuses to
   * guess between). Counted, never silently dropped - but neither retrieved
   * nor dead, because no page is provably named.
   */
  readonly unresolved_ids: number;
  readonly gate_caveat: string;
}

/** Paths this record surfaced, by the spellings the emitters use. */
function surfacedPaths(record: ContinuityRecord): ReadonlyArray<string> {
  const out: string[] = [];
  for (const ref of record.sourceRefs) {
    if (typeof ref?.path === "string" && ref.path.length > 0) out.push(ref.path);
  }
  const top = record.payload["top_artifacts"];
  if (Array.isArray(top)) {
    for (const row of top) {
      if (row !== null && typeof row === "object") {
        const path = (row as { path?: unknown }).path;
        if (typeof path === "string" && path.length > 0) out.push(path);
      }
    }
  }
  return out;
}

/** Id-only surfaced entries (an emitter that records `{ id }` rows). */
function surfacedIds(record: ContinuityRecord): ReadonlyArray<string> {
  const out: string[] = [];
  const top = record.payload["top_artifacts"];
  if (Array.isArray(top)) {
    for (const row of top) {
      if (row !== null && typeof row === "object") {
        const path = (row as { path?: unknown }).path;
        const id = (row as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0 && typeof path !== "string") out.push(id);
      }
    }
  }
  return out;
}

/**
 * A surfaced spelling as the walk spells pages: vault-relative posix NFC.
 * An absolute path inside the vault relativizes; separators normalize; a
 * path leaving the vault normalizes to nothing it could match.
 */
function normalizeSurfaced(vault: string, path: string): string {
  const rel = isAbsolute(path) ? relative(vault, path) : path;
  if (rel === "" || rel.startsWith("..")) return "";
  // Records arrive from every device shard: both separators normalize,
  // not just this host's.
  return canonicalNotePath(rel.replaceAll("\\", "/").split(sep).join("/"));
}

/** Fold one continuity kind into the retrieved set and the window span. */
function foldRecords(
  vault: string,
  kind: "recall_telemetry" | "recall_observed_use",
  opts: DeadWeightOptions,
  stems: ReadonlyMap<string, string[]>,
  retrieved: Set<string>,
  window: { since: string | null; until: string | null },
  unresolved: { count: number },
): void {
  const records = listContinuityRecords(vault, {
    kind,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
  });
  const include = opts.includePath;
  for (const record of records) {
    const visible: string[] = [];
    for (const raw of surfacedPaths(record)) {
      const path = normalizeSurfaced(vault, raw);
      if (path !== "") {
        retrieved.add(path);
        if (include === undefined || include(path)) visible.push(path);
      }
    }
    for (const id of surfacedIds(record)) {
      // An id-only entry names a page through its unique file stem. A stem
      // matching nothing - or matching two pages, which the fold refuses to
      // guess between - counts as unresolved and names nothing.
      const hits = stems.get(id) ?? stems.get(id.toLowerCase());
      const path = hits?.[0];
      if (hits === undefined || hits.length !== 1 || path === undefined) {
        unresolved.count += 1;
        continue;
      }
      retrieved.add(path);
      if (include === undefined || include(path)) visible.push(path);
    }
    // The window rides the caller's view, the same reach/owner boundary
    // the counts use: a record that named pages but none this caller may
    // see disclosed nothing it may see, so its timestamp must not widen
    // or shift the reported window. A record naming nothing keeps its span.
    if (
      include !== undefined &&
      visible.length === 0 &&
      (surfacedPaths(record).length > 0 || surfacedIds(record).length > 0)
    ) {
      continue;
    }
    const at = record.createdAt;
    if (typeof at === "string" && at.length > 0) {
      if (window.since === null || at < window.since) window.since = at;
      if (window.until === null || at > window.until) window.until = at;
    }
  }
}

/**
 * Fold the dead-weight report for `vault`. Read-only: no emit, no write,
 * no clock - the window is the matched records' own span.
 */
export function computeDeadWeight(vault: string, opts: DeadWeightOptions = {}): DeadWeightReport {
  // The walk counts every extension; recall surfaces pages, so the
  // denominator is the included `.md` population.
  const walked = walkVaultScopePaths(vault, resolveVaultScope(vault)).filter((p) =>
    p.endsWith(".md"),
  );
  const include = opts.includePath;
  const full = new Set(include === undefined ? walked : walked.filter(include));
  const retrieved = new Set<string>();
  const window: { since: string | null; until: string | null } = { since: null, until: null };
  // The stem index id-only entries resolve through: file stem -> the walked
  // pages carrying it, in walk order. One page resolves; zero or two do not.
  const stems = new Map<string, string[]>();
  for (const path of walked) {
    const stem = basename(path).replace(/\.md$/i, "");
    const stemKey = stem.toLowerCase();
    const hits = stems.get(stemKey);
    if (hits === undefined) {
      stems.set(stemKey, [path]);
      if (stem !== stemKey) stems.set(stem, [path]);
    } else {
      hits.push(path);
    }
  }
  const unresolved = { count: 0 };
  foldRecords(vault, "recall_telemetry", opts, stems, retrieved, window, unresolved);
  foldRecords(vault, "recall_observed_use", opts, stems, retrieved, window, unresolved);

  let pagesRetrieved = 0;
  for (const path of retrieved) {
    // A retrieved-but-vanished path names a page the vault no longer
    // holds; it must not inflate the retrieved count.
    if (full.has(path)) pagesRetrieved++;
  }
  const dead = [...full].filter((path) => !retrieved.has(path)).toSorted();
  const limit = Math.max(0, Math.floor(opts.deadLimit ?? DEAD_WEIGHT_DEFAULT_LIMIT));
  return Object.freeze({
    window: Object.freeze(window),
    pages_total: full.size,
    pages_retrieved: pagesRetrieved,
    dead_count: dead.length,
    dead: Object.freeze(dead.slice(0, limit).map((path) => Object.freeze({ path }))),
    unresolved_ids: unresolved.count,
    gate_caveat: DEAD_WEIGHT_GATE_CAVEAT,
  });
}
