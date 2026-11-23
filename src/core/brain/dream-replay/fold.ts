/**
 * The fold of the `dream-replay` stream (design D5): the last covered
 * day, the open window if any, the positions the next admission starts
 * from, and the effective times the admissions gave. Pure: records in,
 * state out, in the store's fold order (clock, device, id), so every
 * machine that holds the records folds the same state.
 */

import { compareRecords, type StoreRecord } from "../../store/envelope.ts";
import type { ShardPosition } from "../../store/read/shards-from.ts";
import { foldReplayLedgers, type ReplayLedgers } from "./ledgers.ts";
import { WINDOW_PLAN_VERSION } from "./records.ts";
import {
  DREAM_ADMISSION_KIND,
  DREAM_ADMISSION_PRIVATE_KIND,
  DREAM_BOOTSTRAP_KIND,
  DREAM_COVERAGE_KIND,
  DREAM_WINDOW_PLAN_KIND,
  type DreamAdmissionBody,
  type DreamAdmissionPrivateBody,
  type DreamBootstrapBody,
  type DreamCoverageBody,
} from "./records.ts";

export interface FoldedRecord<Body> {
  readonly id: string;
  readonly device: string;
  readonly body: Body;
}

export interface DreamReplayState {
  /** Coverage records by window (the first in fold order per window). */
  readonly coverage: ReadonlyMap<string, FoldedRecord<DreamCoverageBody>>;
  /** The newest covered day, or null when nothing is covered. */
  readonly lastCovered: string | null;
  /** How many windows of each day are covered (a day is evaluated again only as today's window). */
  readonly evaluations: ReadonlyMap<string, number>;
  /** The newest complete (gap-free) admission of each window. */
  readonly admissions: ReadonlyMap<string, FoldedRecord<DreamAdmissionBody>>;
  /** The newest admission of any kind, for the age of a lasting gap. */
  readonly latestAdmission: FoldedRecord<DreamAdmissionBody> | null;
  /** Plan records of this encoding by window (the first in fold order per window). */
  readonly plans: ReadonlyMap<string, FoldedRecord<Record<string, unknown>>>;
  /** The window that has a complete admission and no coverage: finished first. */
  readonly open: FoldedRecord<DreamAdmissionBody> | null;
  /**
   * Where the next admission reads from: the boundary of the newest
   * complete admission. Null when no window was ever admitted.
   */
  readonly positions: ReadonlyArray<ShardPosition> | null;
  /** Effective times of late and clamped records, by record id. */
  readonly effective: ReadonlyMap<string, string>;
  /** Ids of the late and clamped records an admission read from `private`. */
  readonly privateAdmitted: ReadonlySet<string>;
  /**
   * Windows whose admission names a private part this fold does not hold:
   * on a device that holds `private`, a part that has not synced yet.
   */
  readonly unmergedParts: ReadonlyArray<string>;
  /** The ledgers the pass keeps between windows (`ledgers.ts`). */
  readonly ledgers: ReplayLedgers;
  /** The newest record of the first replay's inventory (`bootstrap.ts`), or null. */
  readonly bootstrap: DreamBootstrapBody | null;
}

/** The name of the `seq`-th evaluation of `day`: the day itself first, then `<day>#<seq>`. */
export function windowName(day: string, seq: number): string {
  return seq === 0 ? day : `${day}#${seq}`;
}

/** The window a record body names: its `window`, or its day for a record that names none. */
function windowOf(body: Record<string, unknown>): string {
  return typeof body["window"] === "string" ? body["window"] : (body["day"] as string);
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isAdmission(body: Record<string, unknown>): boolean {
  return (
    isDay(body["day"]) &&
    Array.isArray(body["positions"]) &&
    Array.isArray(body["gaps"]) &&
    Array.isArray(body["late"]) &&
    Array.isArray(body["clamped"])
  );
}

function isAdmissionPrivate(body: Record<string, unknown>): boolean {
  return isDay(body["day"]) && Array.isArray(body["late"]) && Array.isArray(body["clamped"]);
}

function isCoverage(body: Record<string, unknown>): boolean {
  return isDay(body["day"]) && typeof body["admission"] === "string";
}

/** Fold the records of the `dream-replay` stream. */
export function foldDreamReplay(records: ReadonlyArray<StoreRecord>): DreamReplayState {
  const ordered = records.toSorted(compareRecords);
  const coverage = new Map<string, FoldedRecord<DreamCoverageBody>>();
  const admissions = new Map<string, FoldedRecord<DreamAdmissionBody>>();
  const plans = new Map<string, FoldedRecord<Record<string, unknown>>>();
  let latestAdmission: FoldedRecord<DreamAdmissionBody> | null = null;
  let latestComplete: FoldedRecord<DreamAdmissionBody> | null = null;
  let bootstrap: DreamBootstrapBody | null = null;
  // The private parts of admissions, by their own record id: an admission
  // names its part (`private_part`).
  const privateParts = new Map<string, DreamAdmissionPrivateBody>();
  for (const record of ordered) {
    const body = record.body as Record<string, unknown>;
    if (record.kind === DREAM_ADMISSION_KIND && isAdmission(body)) {
      const folded = {
        id: record.id,
        device: record.device,
        body: body as unknown as DreamAdmissionBody,
      };
      latestAdmission = folded;
      // A window that has a plan is never admitted again (D5): a later
      // admission of a planned window is left alone.
      const window = windowOf(body);
      if (folded.body.gaps.length === 0 && !plans.has(window)) {
        admissions.set(window, folded);
        latestComplete = folded;
      }
    } else if (record.kind === DREAM_ADMISSION_PRIVATE_KIND && isAdmissionPrivate(body)) {
      privateParts.set(record.id, body as unknown as DreamAdmissionPrivateBody);
    } else if (record.kind === DREAM_BOOTSTRAP_KIND && typeof body["done"] === "boolean") {
      // A finished inventory is never replaced by a later page.
      if (bootstrap?.done !== true) bootstrap = body as unknown as DreamBootstrapBody;
    } else if (
      record.kind === DREAM_WINDOW_PLAN_KIND &&
      isDay(body["day"]) &&
      // A plan of another encoding cannot be applied: its window is planned
      // again, and that plan is the window's.
      body["version"] === WINDOW_PLAN_VERSION
    ) {
      const window = windowOf(body);
      if (!plans.has(window)) plans.set(window, { id: record.id, device: record.device, body });
    } else if (record.kind === DREAM_COVERAGE_KIND && isCoverage(body)) {
      const window = windowOf(body);
      if (!coverage.has(window)) {
        coverage.set(window, {
          id: record.id,
          device: record.device,
          body: body as unknown as DreamCoverageBody,
        });
      }
    }
  }
  // An admission is whole only with its private part. A device that does
  // not hold `private` has no part to merge: it read nothing private.
  const privateAdmitted = new Set<string>();
  const unmergedParts: string[] = [];
  const whole = (admission: FoldedRecord<DreamAdmissionBody>): FoldedRecord<DreamAdmissionBody> => {
    const named = admission.body.private_part;
    const part = typeof named === "string" ? privateParts.get(named) : undefined;
    if (part === undefined) {
      if (typeof named === "string") unmergedParts.push(admission.body.window);
      return admission;
    }
    for (const entry of [...part.late, ...part.clamped]) privateAdmitted.add(entry.id);
    return {
      ...admission,
      body: {
        ...admission.body,
        late: [...admission.body.late, ...part.late],
        clamped: [...admission.body.clamped, ...part.clamped],
      },
    };
  };
  for (const [window, admission] of admissions) admissions.set(window, whole(admission));
  let lastCovered: string | null = null;
  const evaluations = new Map<string, number>();
  for (const { body } of coverage.values()) {
    if (lastCovered === null || body.day > lastCovered) lastCovered = body.day;
    evaluations.set(body.day, (evaluations.get(body.day) ?? 0) + 1);
  }
  let open: FoldedRecord<DreamAdmissionBody> | null = null;
  for (const [window, admission] of admissions) {
    if (coverage.has(window)) continue;
    if (lastCovered !== null && admission.body.day < lastCovered) continue;
    if (open === null || admission.body.day < open.body.day) open = admission;
  }
  const effective = new Map<string, string>();
  for (const admission of admissions.values()) {
    for (const entry of [...admission.body.late, ...admission.body.clamped]) {
      if (typeof entry?.id === "string" && typeof entry.at === "string") {
        effective.set(entry.id, entry.at);
      }
    }
  }
  return {
    coverage,
    lastCovered,
    evaluations,
    admissions,
    latestAdmission,
    plans,
    open,
    positions: latestComplete === null ? null : latestComplete.body.positions,
    effective,
    privateAdmitted,
    unmergedParts,
    ledgers: foldReplayLedgers(records),
    bootstrap,
  };
}
