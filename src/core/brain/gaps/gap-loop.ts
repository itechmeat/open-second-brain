/**
 * Knowledge-gap loop (theme A, t_67d38036).
 *
 * Closes the loop on recurring recall gaps: recurring gaps promote to
 * durable vault task notes, open tasks render as a session-start agenda,
 * and a task auto-closes once its topic is recalled with sufficient
 * confidence - mirroring the dream freshness auto-resolve precedent (a
 * recorded status flip in frontmatter, never a silent mutation).
 *
 * Language-agnostic by construction: gap topics are telemetry keys taken
 * verbatim from the recall-telemetry `gap_counts` aggregate, never words
 * classified from prose. Task notes are PLAIN durable files under the Brain
 * area (`Brain/gap-tasks/`); they never touch the Hermes kanban board.
 *
 * Deliberately I/O-scoped to the vault and free of any hook/config
 * concern, so recurrence, promotion, agenda, and auto-close are each
 * independently unit-testable. The opt-in flags and wiring live in the
 * session-start / session-end hooks.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { brainGapTasksDir, BRAIN_GAP_TASKS_REL } from "../paths.ts";
import { summarizeRecallTelemetry } from "../recall-telemetry.ts";
import { renderActivityTimeline, type ActivityItem } from "../render/activity-line.ts";
import type { RecallRetriever } from "../recall-inject.ts";
import { parseFrontmatterText, writeFrontmatterAtomic } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";

/** Default recurrence threshold: a gap must recur this often to promote. */
export const GAP_LOOP_RECURRENCE_THRESHOLD = 3;

/** Default normalized-score floor a recall must clear to auto-close a task. */
export const GAP_LOOP_AUTO_CLOSE_FLOOR = 0.5;

export const GAP_TASK_KIND = "brain-gap-task";
export const GAP_TASK_STATUS_OPEN = "open";
export const GAP_TASK_STATUS_CLOSED = "closed";

/** One gap that recurred often enough to be actionable. */
export interface RecurringGap {
  readonly topic: string;
  readonly occurrences: number;
}

/**
 * Recurring gaps from the recall-telemetry `gap_counts` aggregate, filtered
 * to those recurring at least `threshold` times and ordered most-frequent
 * first (topic as a stable tie-break). The gap topic is the telemetry key
 * verbatim - no natural-language classification.
 */
export function detectRecurringGaps(
  vault: string,
  opts: { threshold?: number } = {},
): ReadonlyArray<RecurringGap> {
  const threshold = opts.threshold ?? GAP_LOOP_RECURRENCE_THRESHOLD;
  const { gap_counts } = summarizeRecallTelemetry(vault);
  return Object.freeze(
    Object.entries(gap_counts)
      .filter(([, count]) => count >= threshold)
      .map(([topic, count]) => Object.freeze({ topic, occurrences: count }))
      .toSorted(
        (a, b) =>
          b.occurrences - a.occurrences || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0),
      ),
  );
}

/**
 * Stable, filesystem-safe, collision-free dedupe key for a gap topic: a
 * short hash of the trimmed topic. Re-promotion of the same topic resolves
 * to the same key (and thus the same note), so a gap can never fork into
 * two competing task files.
 */
export function gapTaskKey(topic: string): string {
  return `gap-${createHash("sha256").update(topic.trim()).digest("hex").slice(0, 16)}`;
}

export interface GapPromotionResult {
  /** Keys of gap tasks created by this run. */
  readonly created: ReadonlyArray<string>;
  /** Keys skipped because a task with that key already existed. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Promote every recurring gap to exactly one durable gap-task note, deduped
 * on the stable gap key via an exclusive create - a topic already carrying
 * a task (open or closed) is skipped, never overwritten or forked.
 */
export function promoteGapsToTasks(
  vault: string,
  opts: { threshold?: number; now: Date },
): GapPromotionResult {
  const dir = brainGapTasksDir(vault);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const gap of detectRecurringGaps(vault, { threshold: opts.threshold })) {
    const key = gapTaskKey(gap.topic);
    const path = join(dir, `${key}.md`);
    const metadata: FrontmatterMap = {
      kind: GAP_TASK_KIND,
      gap_key: key,
      gap_topic: gap.topic,
      status: GAP_TASK_STATUS_OPEN,
      occurrences: String(gap.occurrences),
      created_at: opts.now.toISOString(),
    };
    const body =
      `Recurring recall gap detected ${gap.occurrences} times. ` +
      `Add vault coverage for this topic; the task auto-closes once the ` +
      `topic is recalled with sufficient confidence.`;
    try {
      writeFrontmatterAtomic(path, metadata, body, {
        existsErrorKind: "gap task",
        vaultForRelativePath: vault,
      });
      created.push(key);
    } catch (exc) {
      if (isAlreadyExists(exc)) {
        skipped.push(key);
        continue;
      }
      throw exc;
    }
  }
  return Object.freeze({ created: Object.freeze(created), skipped: Object.freeze(skipped) });
}

export interface GapTask {
  readonly key: string;
  readonly topic: string;
  readonly status: string;
  readonly occurrences: number;
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
        createdAt: stringField(fm["created_at"]),
        path,
      }),
    );
  }
  return Object.freeze(
    tasks.toSorted(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0),
    ),
  );
}

/**
 * Render open gap tasks as a compact session-start agenda through the
 * shared activity helper (each task is an `openQuestion` item, so it carries
 * the fixed structural `open` marker and a relative-age label). Returns the
 * empty string when there is nothing open.
 */
export function renderGapAgenda(vault: string, now: Date): string {
  const open = listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN });
  if (open.length === 0) return "";
  const items: ReadonlyArray<ActivityItem> = open.map((task) => ({
    kind: "openQuestion",
    text: `${task.topic} (recall gap x${task.occurrences})`,
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

function isAlreadyExists(exc: unknown): boolean {
  if ((exc as NodeJS.ErrnoException | null)?.code === "EEXIST") return true;
  return exc instanceof Error && exc.message.includes("already exists");
}
