/**
 * Foresight (t_08a79c81): the Brain's first forward-looking surface.
 * Every other temporal projection (daily brief, weekly synthesis,
 * monthly review, retention) looks backward; foresight folds the
 * continuity log and the recurrence ladder FORWARD - cadence
 * arithmetic projects when a routine comes due next, and recent open
 * commitments / open questions surface as the obligations most
 * likely to matter soon. A fold, not a planner: only deterministic
 * projections, every item carries sources, an empty vault folds to
 * an empty envelope.
 */

import { listContinuityRecords } from "../continuity/store.ts";
import { listRecurrenceCadences } from "../recurrence.ts";
import { isoDate, isoSecond } from "../time.ts";

export const FORESIGHT_SCHEMA_VERSION = 1;
/** Cap on items per envelope. */
export const FORESIGHT_MAX_ITEMS = 20;
/** Default forward horizon, in days. */
export const FORESIGHT_HORIZON_DAYS = 14;
/** Open commitments/questions older than this never surface. */
export const FORESIGHT_EXTRACT_LOOKBACK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX_LEN = 160;

export type ForesightItemKind = "recurring" | "commitment" | "open_question";

export interface ForesightItem {
  readonly kind: ForesightItemKind;
  readonly title: string;
  /** Projected due date (ISO date) for recurring items; null otherwise. */
  readonly due: string | null;
  /** Deterministic evidence for why this item is anticipated. */
  readonly why: string;
  readonly sources: ReadonlyArray<string>;
}

export interface ForesightEnvelope {
  readonly version: typeof FORESIGHT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly horizonDays: number;
  readonly upcoming: ReadonlyArray<ForesightItem>;
}

export interface BuildForesightOptions {
  readonly now: Date;
  readonly horizonDays?: number;
}

function recurringItems(vault: string, nowMs: number, horizonDays: number): ForesightItem[] {
  const out: Array<{ item: ForesightItem; dueMs: number }> = [];
  for (const cadence of listRecurrenceCadences(vault)) {
    if (cadence.meanIntervalDays === null) continue;
    const lastMs = Date.parse(cadence.lastAt);
    if (!Number.isFinite(lastMs)) continue;
    const dueMs = lastMs + cadence.meanIntervalDays * DAY_MS;
    // Overdue routines stay in - they are the likeliest next need of
    // all - but anything past the horizon is not foresight yet.
    if (dueMs > nowMs + horizonDays * DAY_MS) continue;
    const title = `Recurring: ${cadence.topScope || cadence.contentHash.slice(0, 12)}`;
    out.push({
      dueMs,
      item: Object.freeze({
        kind: "recurring" as const,
        title: title.slice(0, TITLE_MAX_LEN),
        due: isoDate(new Date(dueMs)),
        why:
          `seen ${cadence.supportCount}x, every ~${Math.round(cadence.meanIntervalDays)}d, ` +
          `last ${cadence.lastAt.slice(0, 10)} (${cadence.commitment})`,
        sources: Object.freeze([`recurrence:${cadence.contentHash}`]),
      }),
    });
  }
  out.sort((a, b) => a.dueMs - b.dueMs || (a.item.title < b.item.title ? -1 : 1));
  return out.map((x) => x.item);
}

function extractItems(vault: string, nowMs: number): ForesightItem[] {
  const since = isoSecond(new Date(nowMs - FORESIGHT_EXTRACT_LOOKBACK_DAYS * DAY_MS));
  const records = listContinuityRecords(vault, { kind: "pre_compact_extract", since });
  const out: Array<{ item: ForesightItem; createdAt: string }> = [];
  for (const record of records) {
    const extractType = record.payload["extract_type"];
    if (extractType !== "commitment" && extractType !== "open_question") continue;
    const text = record.payload["text"];
    if (typeof text !== "string" || text.trim() === "") continue;
    out.push({
      createdAt: record.createdAt,
      item: Object.freeze({
        kind: extractType,
        title: text.trim().slice(0, TITLE_MAX_LEN),
        due: null,
        why: `open ${extractType.replace("_", " ")} captured ${record.createdAt.slice(0, 10)}`,
        sources: Object.freeze(record.sourceRefs.map((ref) => ref.id)),
      }),
    });
  }
  // Newest first inside each kind; commitments ahead of questions.
  out.sort((a, b) => {
    if (a.item.kind !== b.item.kind) return a.item.kind === "commitment" ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.item.title < b.item.title ? -1 : 1;
  });
  return out.map((x) => x.item);
}

/**
 * Fold the vault's forward-looking evidence into a bounded,
 * deterministic envelope: recurring routines due within the horizon
 * (soonest first), then recent open commitments, then open questions.
 */
export function buildForesight(vault: string, opts: BuildForesightOptions): ForesightEnvelope {
  const horizonDays = opts.horizonDays ?? FORESIGHT_HORIZON_DAYS;
  const nowMs = opts.now.getTime();
  const upcoming = [...recurringItems(vault, nowMs, horizonDays), ...extractItems(vault, nowMs)];
  return Object.freeze({
    version: FORESIGHT_SCHEMA_VERSION,
    generatedAt: isoSecond(opts.now),
    horizonDays,
    upcoming: Object.freeze(upcoming.slice(0, FORESIGHT_MAX_ITEMS)),
  });
}
