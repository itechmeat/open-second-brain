/**
 * Knowledge-gap loop (theme A, t_67d38036).
 *
 * Closes the loop on recurring recall gaps: recurring gaps promote to
 * durable vault task notes, open tasks render as a session-start agenda,
 * and a task auto-closes once its topic is recalled with sufficient
 * confidence - mirroring the dream freshness auto-resolve precedent (a
 * recorded status flip in frontmatter, never a silent mutation).
 *
 * Two independent recurrence sources feed it (signals-that-survive, unit
 * 6): the structural recall-telemetry `gap_counts` aggregate, whose topic
 * is a coarse telemetry code, and the recall-adequacy verdict stamped onto
 * the cross-query demand log, whose topic is a fine term bucket. They are
 * counted and keyed separately and NEVER summed - `occurrences` would
 * otherwise mean a different thing per row.
 *
 * Language-agnostic by construction: a structural topic is a telemetry key
 * taken verbatim, and a verdict topic is the IDF-derived bucket key
 * `normalizeQueryTerms` computes - never words classified from prose. Task
 * notes are PLAIN durable files under the Brain area (`Brain/gap-tasks/`);
 * they never touch the Hermes kanban board.
 *
 * Deliberately I/O-scoped to the vault and free of any hook/config
 * concern, so recurrence, promotion, agenda, and auto-close are each
 * independently unit-testable. The opt-in flags and wiring live in the
 * session-start / session-end hooks.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { brainGapTasksDir, BRAIN_GAP_TASKS_REL } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { aggregateUnmetRecall } from "../query-demand.ts";
import { summarizeRecallTelemetry } from "../recall-telemetry.ts";
import { renderActivityTimeline, type ActivityItem } from "../render/activity-line.ts";
import type { RecallRetriever } from "../recall-inject.ts";
import { isFileAlreadyExists } from "../../fs-atomic.ts";
import { parseFrontmatterText, writeFrontmatterAtomic } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";

/** Default recurrence threshold: a gap must recur this often to promote. */
export const GAP_LOOP_RECURRENCE_THRESHOLD = 3;

/** Default normalized-score floor a recall must clear to auto-close a task. */
export const GAP_LOOP_AUTO_CLOSE_FLOOR = 0.5;

/**
 * Most gap tasks one promotion run may mint. The cap is load-bearing, not
 * polish: without it a single bad afternoon of empty recalls fills the
 * vault with notes. Rows above the cap are not dropped - detection is
 * ordered most-frequent first, so the remainder is minted by the next run.
 */
export const GAP_LOOP_MAX_PROMOTIONS_PER_RUN = 5;

/**
 * Most gap-task notes the directory may hold at once.
 *
 * The per-run mint cap bounds a BURST; this bounds the TOTAL. Both are
 * needed now that the adequacy source exists: the structural source drew
 * topics from a fixed set of telemetry codes, so the reachable file count
 * was small by construction, while a verdict topic is arbitrary
 * normalised query text and the reachable count became "however many
 * distinct questions the demand log still remembers". A backlog this size
 * is already past the point an operator can work through, so refusing to
 * mint past it costs nothing that was going to be read.
 */
export const GAP_TASKS_MAX_NOTES = 200;

/**
 * How long a CLOSED gap task is kept before the loop removes it.
 *
 * A closed task is a finished record, not a backlog item: it stops being
 * rendered, stops being auto-closed, and exists only so a re-promotion of
 * the same topic is deduped against it. One month is long enough for that
 * dedupe to be useful and short enough that closed work does not
 * accumulate for the life of the vault. An OPEN task is never removed by
 * age - deleting an operator's outstanding work would be the silent loss
 * this loop exists to prevent.
 */
export const GAP_TASK_CLOSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Recurrence source: the structural recall-telemetry `gap_counts` aggregate. */
export const GAP_SOURCE_TELEMETRY = "recall_telemetry";
/** Recurrence source: unmet recall-adequacy verdicts on the demand log. */
export const GAP_SOURCE_ADEQUACY = "recall_adequacy";

export const GAP_SOURCES = [GAP_SOURCE_TELEMETRY, GAP_SOURCE_ADEQUACY] as const;
export type GapSource = (typeof GAP_SOURCES)[number];

/**
 * Agenda and body wording per source, so a coarse telemetry code bucket
 * never reads as the same kind of row as a fine term bucket.
 */
const GAP_LABEL_BY_SOURCE: Readonly<Record<GapSource, string>> = Object.freeze({
  [GAP_SOURCE_TELEMETRY]: "recall gap",
  [GAP_SOURCE_ADEQUACY]: "weak recall",
});

export const GAP_TASK_KIND = "brain-gap-task";
export const GAP_TASK_STATUS_OPEN = "open";
export const GAP_TASK_STATUS_CLOSED = "closed";

/** One gap that recurred often enough to be actionable. */
export interface RecurringGap {
  readonly topic: string;
  readonly occurrences: number;
  /** Which recurrence source counted it; rows are never merged across sources. */
  readonly source: GapSource;
}

/**
 * Recurring gaps from BOTH recurrence sources, filtered to those recurring
 * at least `threshold` times and ordered most-frequent first (source then
 * topic as stable tie-breaks).
 *
 * A topic that appears in both sources yields two rows, each carrying its
 * own count. Summing them would produce a number that means neither "this
 * telemetry code fired N times" nor "this question was asked N times".
 */
export function detectRecurringGaps(
  vault: string,
  opts: { threshold?: number } = {},
): ReadonlyArray<RecurringGap> {
  const threshold = opts.threshold ?? GAP_LOOP_RECURRENCE_THRESHOLD;
  const rows = [...structuralGaps(vault), ...adequacyGaps(vault)].filter(
    (gap) => gap.occurrences >= threshold,
  );
  return Object.freeze(rows.toSorted(compareGaps));
}

/** The structural source: telemetry codes taken verbatim as topics. */
function structuralGaps(vault: string): ReadonlyArray<RecurringGap> {
  const { gap_counts } = summarizeRecallTelemetry(vault);
  return Object.entries(gap_counts).map(([topic, count]) =>
    Object.freeze({ topic, occurrences: count, source: GAP_SOURCE_TELEMETRY }),
  );
}

/** The verdict source: unmet-recall term buckets from the demand log. */
function adequacyGaps(vault: string): ReadonlyArray<RecurringGap> {
  return aggregateUnmetRecall(vault).map((bucket) =>
    Object.freeze({
      topic: bucket.key,
      occurrences: bucket.occurrences,
      source: GAP_SOURCE_ADEQUACY,
    }),
  );
}

function compareGaps(a: RecurringGap, b: RecurringGap): number {
  return (
    b.occurrences - a.occurrences ||
    compareStrings(a.source, b.source) ||
    compareStrings(a.topic, b.topic)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable, filesystem-safe, collision-free dedupe key for a gap topic: a
 * short hash of the trimmed topic, namespaced by its recurrence source.
 * Re-promotion of the same topic from the same source resolves to the same
 * key (and thus the same note), so a gap can never fork into two competing
 * task files - while a topic that happens to be textually identical across
 * the two sources still gets one note each.
 *
 * BOTH sources are namespaced, and the source is LENGTH-PREFIXED so the
 * hashed material is an injective encoding of the (source, topic) pair.
 * Namespacing only one of them left the other's topic space able to spell
 * the namespace: a telemetry gap is caller-supplied text, so a code
 * literally spelled `recall_adequacy:<x>` hashed to the same key as the
 * adequacy topic `<x>` and the two rows fought over one note.
 *
 * A key minted before this encoding therefore differs from the one this
 * function now returns for the same telemetry topic. The consequence is
 * bounded and self-clearing: the old note is still listed, still
 * auto-closes, and is removed by the closed-task retention above, while a
 * topic that is still recurring mints one note under the new key.
 */
export function gapTaskKey(topic: string, source: GapSource = GAP_SOURCE_TELEMETRY): string {
  const material = `${source.length}:${source}:${topic.trim()}`;
  return `gap-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export interface GapPromotionResult {
  /** Keys of gap tasks created by this run. */
  readonly created: ReadonlyArray<string>;
  /** Keys skipped because a task with that key already existed. */
  readonly skipped: ReadonlyArray<string>;
  /** Keys of closed tasks this run removed under the retention window. */
  readonly pruned: ReadonlyArray<string>;
  /**
   * Recurring gaps this run did NOT mint because the directory is at
   * {@link GAP_TASKS_MAX_NOTES}. Reported rather than silently dropped:
   * a full backlog is an operator condition, not a no-op.
   */
  readonly capped: number;
}

/**
 * Promote every recurring gap to exactly one durable gap-task note, deduped
 * on the stable gap key via an exclusive create - a topic already carrying
 * a task (open or closed) is skipped, never overwritten or forked.
 *
 * At most {@link GAP_LOOP_MAX_PROMOTIONS_PER_RUN} NEW notes are minted per
 * run. A skip costs no budget, so an established backlog never starves a
 * genuinely new gap.
 *
 * The run also enforces the directory's two bounds, in this order: closed
 * tasks past {@link GAP_TASK_CLOSED_RETENTION_MS} are removed first (so
 * the room they free is usable immediately), then minting stops at
 * {@link GAP_TASKS_MAX_NOTES} and the refusal is COUNTED on the result.
 */
export function promoteGapsToTasks(
  vault: string,
  opts: { threshold?: number; now: Date },
): GapPromotionResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const dir = brainGapTasksDir(vault);
  const created: string[] = [];
  const skipped: string[] = [];
  const pruned = pruneExpiredGapTasks(vault, opts.now);
  let noteCount = listGapTasks(vault).length;
  let capped = 0;
  for (const gap of detectRecurringGaps(vault, { threshold: opts.threshold })) {
    if (created.length >= GAP_LOOP_MAX_PROMOTIONS_PER_RUN) break;
    const key = gapTaskKey(gap.topic, gap.source);
    const path = join(dir, `${key}.md`);
    if (noteCount >= GAP_TASKS_MAX_NOTES) {
      // A topic that already carries a note needs no new file, so the cap
      // did not refuse it - counting it as refused would report a backlog
      // pressure that is not there. The exclusive create below stays the
      // authority on skipping; this pre-check only keeps the count honest.
      if (existsSync(path)) skipped.push(key);
      else capped++;
      continue;
    }
    const metadata: FrontmatterMap = {
      kind: GAP_TASK_KIND,
      gap_key: key,
      gap_topic: gap.topic,
      gap_source: gap.source,
      status: GAP_TASK_STATUS_OPEN,
      occurrences: String(gap.occurrences),
      created_at: opts.now.toISOString(),
    };
    const body =
      `Recurring ${GAP_LABEL_BY_SOURCE[gap.source]} detected ${gap.occurrences} times. ` +
      `Add vault coverage for this topic; the task auto-closes once the ` +
      `topic is recalled with sufficient confidence.`;
    try {
      writeFrontmatterAtomic(path, metadata, body, {
        existsErrorKind: "gap task",
        vaultForRelativePath: vault,
      });
      created.push(key);
      noteCount++;
    } catch (exc) {
      if (isFileAlreadyExists(exc)) {
        skipped.push(key);
        continue;
      }
      throw exc;
    }
  }
  return Object.freeze({
    created: Object.freeze(created),
    skipped: Object.freeze(skipped),
    pruned,
    capped,
  });
}

/**
 * Remove every CLOSED gap task whose `closed_at` is older than the
 * retention window, returning the keys removed. A task with no readable
 * `closed_at` is left alone: age that cannot be shown is not assumed, and
 * an unremoved note still counts against the cap, so the bound holds
 * either way.
 */
function pruneExpiredGapTasks(vault: string, now: Date): ReadonlyArray<string> {
  const cutoffMs = now.getTime() - GAP_TASK_CLOSED_RETENTION_MS;
  const removed: string[] = [];
  for (const task of listGapTasks(vault, { status: GAP_TASK_STATUS_CLOSED })) {
    const [fm] = parseFrontmatterText(readFileSync(task.path, "utf8"));
    const closedAtMs = Date.parse(stringField(fm["closed_at"]));
    if (!Number.isFinite(closedAtMs) || closedAtMs >= cutoffMs) continue;
    rmSync(task.path, { force: true });
    removed.push(task.key);
  }
  return Object.freeze(removed);
}

export interface GapTask {
  readonly key: string;
  readonly topic: string;
  readonly status: string;
  readonly occurrences: number;
  /** Which recurrence source minted it (see {@link GAP_SOURCES}). */
  readonly source: GapSource;
  readonly createdAt: string;
  readonly path: string;
}

/**
 * All gap-task notes under the Brain area, optionally filtered by status,
 * ordered most-recent first (topic tie-break). A missing directory yields
 * an empty list.
 */
export function listGapTasks(
  vault: string,
  opts: { status?: string } = {},
): ReadonlyArray<GapTask> {
  const dir = brainGapTasksDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const tasks: GapTask[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    const [fm] = parseFrontmatterText(readFileSync(path, "utf8"));
    if (fm["kind"] !== GAP_TASK_KIND) continue;
    const status = stringField(fm["status"]);
    if (opts.status !== undefined && status !== opts.status) continue;
    tasks.push(
      Object.freeze({
        key: stringField(fm["gap_key"]) || name.replace(/\.md$/, ""),
        topic: stringField(fm["gap_topic"]),
        status,
        occurrences: Number.parseInt(stringField(fm["occurrences"]) || "0", 10) || 0,
        source: coerceGapSource(fm["gap_source"]),
        createdAt: stringField(fm["created_at"]),
        path,
      }),
    );
  }
  return Object.freeze(
    tasks.toSorted(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || compareStrings(a.topic, b.topic),
    ),
  );
}

/**
 * A note minted before the verdict source existed carries no `gap_source`;
 * it is structural by construction, so that is the only safe default
 * (signals-that-survive, unit 6).
 */
function coerceGapSource(value: unknown): GapSource {
  return GAP_SOURCES.includes(value as GapSource) ? (value as GapSource) : GAP_SOURCE_TELEMETRY;
}

/**
 * Render open gap tasks as a compact session-start agenda through the
 * shared activity helper (each task is an `openQuestion` item, so it carries
 * the fixed structural `open` marker and a relative-age label). Returns the
 * empty string when there is nothing open.
 *
 * Each row is labelled by its recurrence source, so a reader can tell a
 * coarse telemetry code bucket from a fine term bucket and never reads the
 * two counts as one number.
 */
export function renderGapAgenda(vault: string, now: Date): string {
  const open = listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN });
  if (open.length === 0) return "";
  const items: ReadonlyArray<ActivityItem> = open.map((task) => ({
    kind: "openQuestion",
    text: `${task.topic} (${GAP_LABEL_BY_SOURCE[task.source]} x${task.occurrences})`,
    timestamp: task.createdAt,
  }));
  return `# Open recall-gap tasks\n${renderActivityTimeline(items, now)}`;
}

export interface GapAutoCloseResult {
  /** Keys of gap tasks closed by this run. */
  readonly closed: ReadonlyArray<string>;
  /** Keys left open (recall below the floor, or the recall failed). */
  readonly kept: ReadonlyArray<string>;
}

/**
 * Auto-close every open gap task whose topic now recalls at or above the
 * confidence floor, flipping its frontmatter status to closed and stamping
 * `closed_at` / `closed_reason` (mirroring the dream freshness auto-resolve
 * precedent). A recall that fails or stays below the floor keeps the task
 * open - fail-safe, never a silent close.
 */
export async function autoCloseRecalledGaps(
  vault: string,
  retriever: RecallRetriever,
  opts: { confidenceFloor?: number; now: Date },
): Promise<GapAutoCloseResult> {
  // Vault-identity write guard (context-integrity-gates, Unit J), like
  // its sibling `promoteGapsToTasks`: closing a task rewrites the note's
  // frontmatter, so it is a write path, not a read.
  assertVaultIdentityForWrite(vault);
  const floor = opts.confidenceFloor ?? GAP_LOOP_AUTO_CLOSE_FLOOR;
  const closed: string[] = [];
  const kept: string[] = [];
  for (const task of listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })) {
    let topScore = 0;
    try {
      // eslint-disable-next-line no-await-in-loop -- one recall per open task, sequential by design
      const set = await retriever(task.topic);
      // Exclude the gap-task notes themselves: a task note carries its own
      // topic verbatim, so counting it would self-close every gap. Only
      // genuine vault coverage elsewhere may close a task.
      topScore = set.candidates
        .filter((candidate) => !isGapTaskPath(candidate.path))
        .reduce((max, candidate) => Math.max(max, candidate.score), 0);
    } catch {
      kept.push(task.key);
      continue;
    }
    if (topScore >= floor) {
      closeGapTask(task, opts.now);
      closed.push(task.key);
    } else {
      kept.push(task.key);
    }
  }
  return Object.freeze({ closed: Object.freeze(closed), kept: Object.freeze(kept) });
}

function closeGapTask(task: GapTask, now: Date): void {
  const [fm, body] = parseFrontmatterText(readFileSync(task.path, "utf8"));
  const updated: FrontmatterMap = {
    ...fm,
    status: GAP_TASK_STATUS_CLOSED,
    closed_at: now.toISOString(),
    closed_reason: "recalled",
  };
  writeFrontmatterAtomic(task.path, updated, body, { overwrite: true });
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Whether a recall candidate path points at a gap-task note (any origin). */
function isGapTaskPath(path: string): boolean {
  return path.includes(BRAIN_GAP_TASKS_REL);
}
