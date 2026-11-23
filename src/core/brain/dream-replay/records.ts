/**
 * Names and record bodies of the dream replay (design D3, D4, D5, D7): the
 * one place that spells its stream and record kinds, so the pass, the
 * fold, doctor and the format document cannot drift apart.
 *
 * Every record of the replay lives in stream `dream-replay` and is written
 * by the device that runs the pass, in the `shared` partition unless it
 * names what the window read from private records (`privacy.ts`): then it
 * goes to `private`. A window is identified by its UTC day, never by the
 * owner or the run.
 */

import type { ShardPosition } from "../../store/read/shards-from.ts";

/** The store stream of the replay. */
export const DREAM_REPLAY_STREAM = "dream-replay";

/** A window's input boundary and the effective times it gave (D3). */
export const DREAM_ADMISSION_KIND = "dream-admission";
/** The late and clamped records of an admission read from `private` (`privacy.ts`). */
export const DREAM_ADMISSION_PRIVATE_KIND = "dream-admission-private";
/** A window's plan, with the frozen payload of every effect (D4, D5). */
export const DREAM_WINDOW_PLAN_KIND = "dream-window-plan";
/** A window is finished (D5). */
export const DREAM_COVERAGE_KIND = "dream-coverage";
/** The first pass's inventory of a brain that predates the replay (D7). */
export const DREAM_BOOTSTRAP_KIND = "dream-bootstrap";
/** The cross-topic allowance of one owner token spent on one day (D4.5). */
export const DREAM_CROSS_TOPIC_SPENT_KIND = "dream-cross-topic-spent";
/** A rollup rung's baseline after a window fired it (D4.5). */
export const DREAM_ROLLUP_BASELINE_KIND = "dream-rollup-baseline";

/** Every record kind of the replay; FORMAT.md documents each. */
export const DREAM_REPLAY_RECORD_KINDS = Object.freeze([
  DREAM_ADMISSION_KIND,
  DREAM_ADMISSION_PRIVATE_KIND,
  DREAM_WINDOW_PLAN_KIND,
  DREAM_COVERAGE_KIND,
  DREAM_BOOTSTRAP_KIND,
  DREAM_CROSS_TOPIC_SPENT_KIND,
  DREAM_ROLLUP_BASELINE_KIND,
] as const);

/** The replay budget of one pass when `dream.replay_budget_ms` is not set (design D6). */
export const DEFAULT_REPLAY_BUDGET_MS = 60_000;

/** How long a source may stay incomplete before a window is admitted without it (D3). */
export const GAP_LEAVE_OUT_MS = 3 * 24 * 3600 * 1000;

/** A record the admission gave a time other than its own. */
export interface AdmittedTime {
  /** The store record id. */
  readonly id: string;
  /** The time the windows judge it by. */
  readonly at: string;
  /** For an application of a rule: the rule (`pref-<slug>`) and the record's own time. */
  readonly subject?: string;
  readonly event_at?: string;
}

/** A shard that could not be read completely. */
export interface AdmissionGap {
  readonly partition: string;
  readonly stream: string;
  readonly shard: string;
  readonly reason: string;
  /** When this source was first seen incomplete. */
  readonly since: string;
}

/** A shard a window was admitted without, after it stayed incomplete (D3). */
export interface AdmissionLeftOut {
  readonly partition: string;
  readonly stream: string;
  readonly shard: string;
  /** Where its records will be read from once it reads again. */
  readonly offset: number;
  readonly since: string;
}

/** Shards a compaction replaced or a rewrite changed, and the records taken as seen (D3, "Rebase"). */
export interface AdmissionRebase {
  readonly shards: ReadonlyArray<string>;
  readonly seen: number;
}

export interface DreamAdmissionBody {
  readonly day: string;
  /** The window's name: its day, or `<day>#<n>` for a later evaluation of today. */
  readonly window: string;
  readonly from: string;
  readonly to: string;
  /** The window's boundary. A shard with a gap keeps its earlier position. */
  readonly positions: ReadonlyArray<ShardPosition>;
  readonly gaps: ReadonlyArray<AdmissionGap>;
  /** Records first seen after their day was covered: judged from this window's start. */
  readonly late: ReadonlyArray<AdmittedTime>;
  /** Records dated after the moment of admission: judged at that moment. */
  readonly clamped: ReadonlyArray<AdmittedTime>;
  readonly left_out: ReadonlyArray<AdmissionLeftOut>;
  readonly rebased: AdmissionRebase | null;
  /** The real moment of the admission. */
  readonly admitted_at: string;
  readonly run: string;
  /** Record id of its `dream-admission-private` part, written before it; absent when it has none. */
  readonly private_part?: string;
}

/**
 * The part of an admission that names records of the `private` partition,
 * kept out of the shared admission record. It is written before the
 * admission, which names it (`private_part`): the fold of a device that
 * holds `private` merges it into that admission, and a part no admission
 * names (a pass stopped between the two writes) is left out.
 */
export interface DreamAdmissionPrivateBody {
  readonly day: string;
  readonly window: string;
  readonly late: ReadonlyArray<AdmittedTime>;
  readonly clamped: ReadonlyArray<AdmittedTime>;
  readonly run: string;
}

export interface DreamCoverageBody {
  readonly day: string;
  readonly window: string;
  /** Record id of the admission the window was evaluated from. */
  readonly admission: string;
  /** Record id of its plan. */
  readonly plan: string;
  readonly owner: string | null;
  readonly run: string;
  /** Windows still behind after this one, when the pass covered it. */
  readonly behind: number;
}

/** UTC bounds of the window of `day`: its first and its last millisecond. */
export function windowBounds(day: string): { readonly from: string; readonly to: string } {
  return { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` };
}

/** The UTC day after `day`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The days from `first` through `last`, inclusive, oldest first; empty when `first` is later. */
export function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last; day = nextDay(day)) out.push(day);
  return out;
}

/** What the inventory has gathered so far. */
export interface BootstrapCounts {
  /** Day of the oldest unconsumed signal seen. */
  readonly oldest_unconsumed: string | null;
  /** Per topic key: the oldest unconsumed signal's time. */
  readonly unconsumed_by_topic: Readonly<Record<string, string>>;
  /** Per topic key: the times of the archived signals seen. */
  readonly archived_by_topic: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly signals_seen: number;
}

export interface DreamBootstrapBody {
  /** The id of the last signal the inventory took, in id order; null before the first page. */
  readonly cursor: string | null;
  readonly counts: BootstrapCounts;
  readonly done: boolean;
  /** The day the replay starts at, once done. */
  readonly start: string | null;
  /** Archived signals that may have qualified for a promotion that never happened. */
  readonly unrecoverable: number;
  /** The day after the last pass that changed something, or null. */
  readonly after_last_pass: string | null;
  readonly run: string;
}

/**
 * The encoding of a window's frozen plan. It lives here, with the record
 * shapes, so the fold reads it without importing the plan builder (which
 * reaches the pass's types and, through them, the owner gate).
 */
export const WINDOW_PLAN_VERSION = 1;
