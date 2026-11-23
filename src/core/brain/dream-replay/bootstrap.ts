/**
 * The first replay on a brain that predates it (design D7): an inventory
 * of the retained inputs in pages, with a durable cursor, that decides the
 * day the replay starts at and counts what can no longer be recovered.
 *
 * The start day is the earliest of: the day of the oldest unconsumed
 * signal; the day of the oldest archived signal that shares a topic key
 * with an unconsumed one and lies within one contradiction window before
 * it; and the day after the last pass the audit log shows to have changed
 * something. It is never later than that last day, and it is today for a
 * brain that never ran a pass. The audit log records only passes that
 * changed something, so the days after it that a pass visited and left
 * unchanged are replayed as empty windows.
 *
 * The initial positions are zero for every shard: the first windows admit
 * everything present with its own time (clamped when dated ahead). No
 * record is late at bootstrap.
 *
 * What cannot be recovered: signals archived before the replay existed
 * that share a topic key with at least `candidate_threshold - 1` others
 * inside one contradiction window (they may have qualified for a
 * promotion that never happened). They are counted, not reopened.
 */

import { readStoreLogEvents } from "../../store/read/log-events.ts";
import { readStoreEntities, type StoreSignal } from "../../store/read/store-entities.ts";
import { topicKey } from "../dream-plan.ts";
import { isoDate } from "../time.ts";
import type { BrainConfig } from "../types.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import type { DreamReplayPass } from "./pass.ts";
import { writeReplayRecord } from "./pass.ts";
import {
  DREAM_BOOTSTRAP_KIND,
  nextDay,
  type BootstrapCounts,
  type DreamBootstrapBody,
} from "./records.ts";

export type { BootstrapCounts, DreamBootstrapBody } from "./records.ts";

/** Signals one page of the inventory takes. */
export const BOOTSTRAP_PAGE_SIZE = 500;

const EMPTY: BootstrapCounts = {
  oldest_unconsumed: null,
  unconsumed_by_topic: {},
  archived_by_topic: {},
  signals_seen: 0,
};

function createdAt(signal: StoreSignal): string | null {
  const value = signal.frontmatter["created_at"];
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function topicOf(signal: StoreSignal): string | null {
  const value = signal.frontmatter["topic"];
  return typeof value === "string" ? topicKey(value) : null;
}

function idOf(signal: StoreSignal): string {
  return String(signal.record.body["id"] ?? "");
}

/** The day after the newest `dream` audit event, or null when none exists. */
function dayAfterLastPass(vault: string | null, configPath?: string): string | null {
  let last: string | null = null;
  const events =
    readStoreLogEvents(
      { from: "0000-01-01", to: "9999-12-31" },
      { vault, ...(configPath !== undefined ? { configPath } : {}) },
      { eventTypes: new Set([BRAIN_LOG_EVENT_KIND.dream]) },
    ) ?? [];
  for (const { entry } of events) {
    if (last === null || entry.timestamp > last) last = entry.timestamp;
  }
  return last === null ? null : nextDay(last.slice(0, 10));
}

/** One page of the inventory folded into `counts`. */
function takePage(counts: BootstrapCounts, page: ReadonlyArray<StoreSignal>): BootstrapCounts {
  let oldest = counts.oldest_unconsumed;
  const unconsumed = { ...counts.unconsumed_by_topic };
  const archived: Record<string, string[]> = {};
  for (const [key, times] of Object.entries(counts.archived_by_topic)) archived[key] = [...times];
  for (const signal of page) {
    const at = createdAt(signal);
    const topic = topicOf(signal);
    if (at === null || topic === null) continue;
    if (signal.state === "active") {
      if (oldest === null || at.slice(0, 10) < oldest) oldest = at.slice(0, 10);
      if (unconsumed[topic] === undefined || at < unconsumed[topic]!) unconsumed[topic] = at;
    } else if (signal.state === "archived") {
      (archived[topic] ??= []).push(at);
    }
  }
  return {
    oldest_unconsumed: oldest,
    unconsumed_by_topic: unconsumed,
    archived_by_topic: archived,
    signals_seen: counts.signals_seen + page.length,
  };
}

/** The start day and the unrecoverable count, once every page is taken. */
function decide(
  counts: BootstrapCounts,
  afterLastPass: string | null,
  cfg: BrainConfig,
  today: string,
): { readonly start: string; readonly unrecoverable: number } {
  const windowMs = cfg.dream.contradiction_window_days * 86_400_000;
  const candidates: string[] = [];
  if (counts.oldest_unconsumed !== null) candidates.push(counts.oldest_unconsumed);
  for (const [topic, firstUnconsumed] of Object.entries(counts.unconsumed_by_topic)) {
    for (const at of counts.archived_by_topic[topic] ?? []) {
      const gap = Date.parse(firstUnconsumed) - Date.parse(at);
      if (gap >= 0 && gap <= windowMs) candidates.push(at.slice(0, 10));
    }
  }
  if (afterLastPass !== null) candidates.push(afterLastPass);
  let start = candidates.length === 0 ? today : candidates.toSorted()[0]!;
  if (start > today) start = today;
  let unrecoverable = 0;
  const peers = Math.max(0, cfg.dream.candidate_threshold - 1);
  for (const times of Object.values(counts.archived_by_topic)) {
    const sorted = [...times].toSorted();
    for (const [index, at] of sorted.entries()) {
      const around = sorted.filter(
        (other, j) => j !== index && Math.abs(Date.parse(other) - Date.parse(at)) <= windowMs,
      ).length;
      if (around >= peers && peers > 0) unrecoverable += 1;
    }
  }
  return { start, unrecoverable };
}

/**
 * The inventory's read of the signals is incomplete (an unreadable shard,
 * a record whose body is pending): a signal it cannot see would move the
 * start day, so the inventory waits for the next pass instead of guessing.
 */
export class BootstrapIncompleteError extends Error {
  constructor(readonly sources: ReadonlyArray<string>) {
    super(
      `the first dream replay waits: its inventory cannot read every signal yet (${sources.join(", ")})`,
    );
    this.name = "BootstrapIncompleteError";
  }
}

/**
 * Run (or continue) the inventory. `checkpoint` is called between pages:
 * a pass that stops there keeps every page it wrote, and the next pass
 * continues from the cursor. Returns the finished inventory.
 */
export function runBootstrap(input: {
  readonly vault: string | null;
  readonly pass: DreamReplayPass;
  readonly cfg: BrainConfig;
  readonly previous: DreamBootstrapBody | null;
  readonly checkpoint: () => void;
}): DreamBootstrapBody {
  if (input.previous?.done === true) return input.previous;
  const today = isoDate(input.pass.now);
  const entities = readStoreEntities(input.pass.configPath);
  if (entities !== null && (entities.unreadable.length > 0 || entities.skippedPending)) {
    throw new BootstrapIncompleteError(
      entities.unreadable.length > 0 ? entities.unreadable : ["a record whose body is pending"],
    );
  }
  const signals = [...(entities?.signals.values() ?? [])].toSorted((a, b) =>
    a.record.body["id"]! < b.record.body["id"]! ? -1 : 1,
  );
  let counts = input.previous?.counts ?? EMPTY;
  let cursor = input.previous?.cursor ?? null;
  const afterLastPass =
    input.previous?.after_last_pass ?? dayAfterLastPass(input.vault, input.pass.configPath);
  let index = cursor === null ? 0 : signals.findIndex((s) => idOf(s) > cursor!);
  if (index < 0) index = signals.length;
  // A page's counts and cursor hold every page before it: the record is
  // private once any signal taken so far is (`privacy.ts`).
  const takenPrivate = (): boolean => signals.slice(0, index).some((signal) => signal.private);
  while (index < signals.length) {
    input.checkpoint();
    const page = signals.slice(index, index + BOOTSTRAP_PAGE_SIZE);
    counts = takePage(counts, page);
    cursor = idOf(page.at(-1)!);
    index += page.length;
    if (index < signals.length) {
      writeReplayRecord(
        input.pass,
        DREAM_BOOTSTRAP_KIND,
        {
          cursor,
          counts,
          done: false,
          start: null,
          unrecoverable: 0,
          after_last_pass: afterLastPass,
          run: input.pass.run,
        } satisfies DreamBootstrapBody,
        takenPrivate(),
      );
    }
  }
  const { start, unrecoverable } = decide(counts, afterLastPass, input.cfg, today);
  const done: DreamBootstrapBody = {
    cursor,
    counts,
    done: true,
    start,
    unrecoverable,
    after_last_pass: afterLastPass,
    run: input.pass.run,
  };
  writeReplayRecord(input.pass, DREAM_BOOTSTRAP_KIND, done, takenPrivate());
  return done;
}
