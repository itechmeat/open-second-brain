/**
 * Names and numbers of the dream work queue (change `dream-work-queue`,
 * design D1): the one place that spells its stream, record kinds, limits,
 * device-local lock and commands, so the records, the fold, the core
 * functions, doctor and the CLI cannot drift apart.
 *
 * The queue holds dream work that needs a model. Only the dream owner's
 * device changes it; every device that holds a partition folds it.
 */

/** The store stream of the queue, in both partitions. */
export const DREAM_WORK_STREAM = "dream-work";

/** A unit of work a pass produced. */
export const DREAM_WORK_ITEM_KIND = "dream-work-item";
/** A take: the item is out under this generation until it expires. */
export const DREAM_WORK_LEASE_KIND = "dream-work-lease";
/** An answer accepted for the item under one lease. */
export const DREAM_WORK_ANSWER_KIND = "dream-work-answer";
/** A failed, refused or released attempt. */
export const DREAM_WORK_ATTEMPT_KIND = "dream-work-attempt";
/** The accepted answer was applied by the operation that produced the item. */
export const DREAM_WORK_APPLIED_KIND = "dream-work-applied";
/** The item was cancelled or superseded. */
export const DREAM_WORK_CLOSED_KIND = "dream-work-closed";
/** A person asked for a parked item to be offered again. */
export const DREAM_WORK_RETRY_KIND = "dream-work-retry";
/**
 * A person approved a text answer held for review (change
 * `dream-launched-agent`, design D7: `dream.apply_drafts: review`).
 */
export const DREAM_WORK_APPROVE_KIND = "dream-work-approve";

/** Every record kind of the queue; FORMAT.md documents each. */
export const DREAM_WORK_RECORD_KINDS = Object.freeze([
  DREAM_WORK_ITEM_KIND,
  DREAM_WORK_LEASE_KIND,
  DREAM_WORK_ANSWER_KIND,
  DREAM_WORK_ATTEMPT_KIND,
  DREAM_WORK_APPLIED_KIND,
  DREAM_WORK_CLOSED_KIND,
  DREAM_WORK_RETRY_KIND,
  DREAM_WORK_APPROVE_KIND,
] as const);

/** The states an item folds to. */
export const DREAM_WORK_STATES = Object.freeze([
  "waiting",
  "leased",
  "accepted",
  "awaiting-review",
  "finished",
  "parked",
  "closed",
] as const);
export type DreamWorkStateName = (typeof DREAM_WORK_STATES)[number];

/** Failed attempts after which an item is parked. */
export const DREAM_WORK_MAX_ATTEMPTS = 5;
/** Wait after the first, second, third failure, then after every later one. */
export const DREAM_WORK_BACKOFF_MS = Object.freeze([
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
] as const);
/** How long a lease is live. */
export const DREAM_WORK_LEASE_MS = 15 * 60_000;
/** Ready work older than this is reported as a backlog. */
export const DREAM_WORK_BACKLOG_MS = 24 * 60 * 60_000;
/** Longest wait for the queue lock. */
export const DREAM_WORK_LOCK_BUDGET_MS = 30_000;
/** Most evidence ids one item carries. */
export const DREAM_WORK_EVIDENCE_MAX = 200;

/** Device-local subdirectory of the queue's state (never synced). */
export const DREAM_QUEUE_STATE_DIR = "dream-queue";
/** Device-local lock target of every writing entry point. */
export const DREAM_QUEUE_LOCK = "queue";

/** The verb that lists the queue. */
export const DREAM_QUEUE_COMMAND = "o2b dream queue";
/** The shared setting that holds text answers for review (`auto` or `review`). */
export { SETTING_DREAM_APPLY_DRAFTS as DREAM_APPLY_DRAFTS_SETTING } from "../../store/constants.ts";

/** The verb that offers a parked item again. */
export const DREAM_QUEUE_RETRY_COMMAND = "o2b dream queue retry";

/** Error code of a queue write on a brain with no dream owner. */
export const DREAM_QUEUE_UNBOUND_CODE = "dream_queue_unbound";
