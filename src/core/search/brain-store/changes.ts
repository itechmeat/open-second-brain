/**
 * The change probe (design D5, task 1.9): "what is new in the brain store
 * since watermark W", answered from the index, never from a store file.
 *
 * A watermark is `<index generation>.<ingest sequence>`. The sequence is
 * the order this machine's index ingested records in, so a record that
 * arrives late by file sync (with an older clock than records already
 * seen) is still new after W. The generation is minted with each index
 * file; a watermark from a replaced index (a rebuild renumbers the
 * sequence) is reported as a reset and the probe answers from the start.
 *
 * The probe catches the index up first, like every read, then returns the
 * new record ids grouped by partition, stream, scope and topic, oldest
 * first, with the watermark to pass next time. A page cut by `limit`
 * returns the watermark of its last record, so the caller pages forward.
 */

import { openReadOrSelfHeal } from "../pipeline/store-open.ts";
import { recordsAfter } from "../store/brain-records.ts";
import { SearchError, type ResolvedSearchConfig } from "../types.ts";
import { catchUpBrainStore, type CatchUpResult } from "./catch-up.ts";
import { STORE_INDEX_GENERATION_KEY } from "./constants.ts";

/** Records one probe returns by default. */
export const CHANGES_DEFAULT_LIMIT = 500;

/** The most records one probe returns. */
export const CHANGES_MAX_LIMIT = 5000;

/** New record ids that share a partition, stream, ledger, scope and topic. */
export interface ChangeGroup {
  readonly partition: string;
  readonly stream: string;
  readonly ledger: string | null;
  readonly scope: string | null;
  readonly topic: string | null;
  /** Record ids in ingest order. */
  readonly ids: ReadonlyArray<string>;
}

export interface BrainChanges {
  /** False when no brain store is in use; nothing else is then reported. */
  readonly storeInUse: boolean;
  /** The watermark to pass as `since` next time; null without a store or an index. */
  readonly watermark: string | null;
  /** True when `since` came from another index generation and the probe started over. */
  readonly reset: boolean;
  /** True when more records are waiting after {@link watermark}. */
  readonly truncated: boolean;
  /** Number of record ids across the groups. */
  readonly count: number;
  readonly groups: ReadonlyArray<ChangeGroup>;
  /**
   * Why the answer may be incomplete: a catch-up that failed leaves
   * records out until a later probe catches up. Empty when it is current.
   */
  readonly warnings: ReadonlyArray<string>;
}

export interface BrainChangesOptions {
  /** A watermark from an earlier probe; absent starts from the first record. */
  readonly since?: string;
  readonly limit?: number;
}

const WATERMARK_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.(0|[1-9]\d{0,15})$/;

/** Parse a watermark; null when it is not one. */
export function parseWatermark(text: string): { generation: string; seq: number } | null {
  const m = WATERMARK_RE.exec(text.trim());
  return m === null ? null : { generation: m[1]!, seq: Number(m[2]) };
}

function formatWatermark(generation: string, seq: number): string {
  return `${generation}.${seq}`;
}

const NO_STORE: BrainChanges = Object.freeze({
  storeInUse: false,
  watermark: null,
  reset: false,
  truncated: false,
  count: 0,
  groups: Object.freeze([]),
  warnings: Object.freeze([]),
});

/** The warning a failed catch-up adds, worded as search words it. */
function catchUpWarnings(results: ReadonlyArray<CatchUpResult>): string[] {
  const failed = results.findLast((r) => r.skipped === "failed");
  return failed === undefined
    ? []
    : [`brain store catch-up failed, records may be missing: ${failed.error}`];
}

/** The new record ids since `opts.since`, grouped; throws `INVALID_INPUT` for a malformed watermark or limit. */
export async function brainChanges(
  config: ResolvedSearchConfig,
  opts: BrainChangesOptions = {},
): Promise<BrainChanges> {
  const since = opts.since === undefined ? null : parseWatermark(opts.since);
  if (opts.since !== undefined && since === null) {
    throw new SearchError(
      "INVALID_INPUT",
      `"${opts.since}" is not a watermark; pass the watermark an earlier probe returned`,
    );
  }
  const limit = opts.limit ?? CHANGES_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > CHANGES_MAX_LIMIT) {
    throw new SearchError("INVALID_INPUT", `limit must be an integer in 1..${CHANGES_MAX_LIMIT}`);
  }
  if (config.brainStore === null || config.brainStore === undefined) return NO_STORE;
  // Catch-up before the read, as every read does; an index the open has
  // to build or upgrade first is caught up right after it.
  const catchUps = [await catchUpBrainStore(config)];
  const index = await openReadOrSelfHeal(config);
  try {
    if (catchUps[0]!.skipped === "no-index" || catchUps[0]!.skipped === "not-current") {
      catchUps.push(await catchUpBrainStore(config, { force: true }));
    }
    const warnings = catchUpWarnings(catchUps);
    const db = index.brainRecordsConnection();
    const generation = index.getState(STORE_INDEX_GENERATION_KEY);
    if (generation === null) return { ...NO_STORE, storeInUse: true, warnings };
    const reset = since !== null && since.generation !== generation;
    const from = since !== null && !reset ? since.seq : 0;
    const rows = recordsAfter(db, from, limit + 1);
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    const groups = new Map<string, ChangeGroup & { ids: string[] }>();
    for (const r of page) {
      const key = JSON.stringify([r.partition, r.stream, r.ledger, r.scope, r.topic]);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          partition: r.partition,
          stream: r.stream,
          ledger: r.ledger,
          scope: r.scope,
          topic: r.topic,
          ids: [],
        };
        groups.set(key, group);
      }
      group.ids.push(r.id);
    }
    // An empty page keeps the caller's position: sequences only grow
    // within a generation, so a record committed after this read is still
    // above it, while a second read of the highest sequence could step
    // past a record committed between the two reads.
    const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : from;
    return {
      storeInUse: true,
      watermark: formatWatermark(generation, lastSeq),
      reset,
      truncated,
      count: page.length,
      groups: [...groups.values()],
      warnings,
    };
  } finally {
    await index.close();
  }
}
