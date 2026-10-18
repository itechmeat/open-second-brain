#!/usr/bin/env -S bun
/**
 * SessionStart hook: opt-in cross-agent log catch-up (t_3b44cd9a).
 *
 * When `log_catchup_enabled` resolves on (env
 * `OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED`, else the `log_catchup_enabled`
 * config key; default OFF), hands the agent the `Brain/log` lines OTHER
 * agents appended since the lane's last look on this device: the newest
 * {@link LOG_CATCHUP_MAX_LINES} lines as one fenced `additionalContext`
 * block, plus a count of older ones, every line attributed to the agent
 * that wrote it. The shared job logbook is the point - agents working
 * the same vault through different runtimes see each other's narrative
 * milestones at session start without anyone polling the log mid-turn.
 *
 * Identity. The hook payload carries no agent name, so "me" resolves the
 * same way every Brain writer does: the config-resolved agent name, and
 * - when no name is configured - this device's device id. Lines authored
 * by that identity are filtered out; with neither resolvable the lane
 * stays silent rather than replay the agent its own lines back. The two
 * identity sources read authorship differently: a configured agent name
 * matches the payload `agent` field (so a same-name line from another
 * device is still self), while the device id exists only in the shard
 * name - writers stamp `agent` with the agent name, the "agent"
 * placeholder on an unconfigured install - so the fallback matches the
 * entry's shard id, which IS the device id.
 *
 * Cursor. A per-identity `(date, shardId, line)` watermark plus
 * per-shard high-water marks (hooks/lib/log-cursor-state.ts,
 * overwrite-only derived state, un-synced): the runtimes sharing this
 * vault carry different agent names, so "since my last look" is a fact
 * about the identity, not the device. The marks cover the cursor date,
 * a window of older dates and the future-dated dates a clock-skewed
 * writer may stamp, so every foreign line shows once. The lane is a
 * PURE read of the log: entries are discovered and read through the
 * shared log-jsonl readers and nothing is
 * ever appended to `Brain/log` - session-capture owns the lifecycle
 * event, and this lane must stay distinguishable from it.
 *
 * Bounded, fail-open. The per-lane caps are constants
 * (`policy/blocks/active.ts`); the block rides the shared untrusted
 * fence because other agents' log text is untrusted vault content; the
 * scan itself is bounded - a parked cursor rescans only its calendar
 * window and a first run only the recent window behind the newest log
 * date, with older days counted and reported, never parsed; and
 * every path exits 0 - flag off is an immediate no-op with zero output.
 */

import {
  isConfiguredAgentName,
  resolveAgentName,
  resolveDeviceId,
  resolveLogCatchupEnabled,
  resolveVault,
} from "../src/core/config.ts";
import { listLogShardFiles, readLogDay } from "../src/core/brain/log-jsonl.ts";
import type { BrainLogEntry } from "../src/core/brain/log.ts";
import { fenceUntrustedContent, neutralizeSingleLine } from "../src/core/brain/untrusted-source.ts";
import {
  renderActivityTimeline,
  type ActivityItem,
} from "../src/core/brain/render/activity-line.ts";
import {
  LOG_CATCHUP_MAX_CHARS,
  LOG_CATCHUP_MAX_LINES,
} from "../src/core/brain/policy/blocks/active.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";
import {
  dateCutoff,
  firstRunScanCutoffDate,
  LOG_CATCHUP_WINDOW_DATES,
  readLogCatchupCursor,
  writeLogCatchupCursor,
  type LogCatchupCursor,
} from "./lib/log-cursor-state.ts";

/** `origin` label stamped on the catch-up block's untrusted-content fence. */
const CATCHUP_FENCE_ORIGIN = "cross-agent-catch-up";

/**
 * Body fields the per-line text derives from, in priority order.
 * Structural, not kind-switched prose: the first populated field wins,
 * and a line whose body carries none of them renders the event kind.
 */
const CATCHUP_BODY_FIELDS: ReadonlyArray<string> = Object.freeze([
  "text",
  "topic",
  "artifact",
  "target",
  "path",
  "reason",
]);

/**
 * Hard cap on ONE rendered catch-up line, ellipsis included. Local to
 * the lane (the other `LOG_CATCHUP_*` caps live in
 * `policy/blocks/active.ts`, which owns the block-level budget):
 * `neutralizeSingleLine` never bounds length, and the block-level trim
 * loop drops oldest-first - without a per-line bound, one over-long
 * foreign line would first push every shorter line out of the block and
 * then not fit itself, muting the lane entirely while the frozen cursor
 * rescans the same history every session. With the cap every line fits,
 * so the newest line always survives the trim.
 */
export const LOG_CATCHUP_MAX_LINE_CHARS = 500;

/** Label for a log line that carries no `agent` attribution. */
const UNATTRIBUTED_AGENT_LABEL = "unattributed";

/**
 * Whether the lane is on: the shared env-then-config resolver, the same
 * one every default-OFF boolean gate reads through. Fail-open - the
 * whole hook body runs under `main().catch`, so an unreadable config
 * degrades to a silent exit-0 start, never a crashed session.
 */
const logCatchupEnabled = resolveLogCatchupEnabled;

/**
 * The identity this run filters its own lines by, and the source that
 * produced it: the config-resolved agent name when one is actually
 * configured, else the device id. Null when neither resolves - the lane
 * cannot tell self from other, so it stays silent instead of replaying
 * the agent its own lines.
 */
interface SelfIdentity {
  readonly value: string;
  /**
   * True when `value` is the device id, not a configured agent name.
   * The payload cannot carry the answer in this mode - every writer
   * stamps `agent` with an agent name, never the device id - so
   * authorship is read off the shard name instead.
   */
  readonly fromDeviceFallback: boolean;
}

function resolveSelfIdentity(): SelfIdentity | null {
  const name = resolveAgentName().trim();
  if (isConfiguredAgentName(name)) return { value: name, fromDeviceFallback: false };
  try {
    const device = resolveDeviceId().trim();
    if (device.length > 0) return { value: device, fromDeviceFallback: true };
  } catch {
    // absorbed: an unresolvable device id leaves the null path below
  }
  return null;
}

/** Where one read entry sits in the merge order, for the watermark. */
interface CatchupPosition {
  readonly date: string;
  readonly shardId: string;
  readonly line: number;
}

/**
 * The oldest date the cursor can still vouch per shard about: the
 * calendar window behind the cursor date. The `days` marks cover only
 * the dates that HAD files when the cursor last parked, so a filter
 * bounded by the marks would treat a date whose shards had not synced
 * yet as outside the window and drop its late-arriving lines forever -
 * the window is a range of calendar dates, not the recorded keys. The
 * arithmetic is the cursor module's shared {@link dateCutoff}.
 */
function windowCutoffDate(cursorDate: string): string {
  return dateCutoff(cursorDate, LOG_CATCHUP_WINDOW_DATES);
}

/**
 * Whether an entry read at `position` is past the cursor. Dates before
 * the cursor date read the decision off that date's `days` marks; the
 * cursor date off `shards`; and a date AFTER the cursor - a skewed
 * writer's future date, which the cursor never parks on - off the
 * `future` marks, so a skewed line is shown once instead of every
 * session until the clock reaches its date. A shard with no mark yet is
 * entirely new; otherwise the entry is new when its line index is past
 * that shard's mark, and a date with no marks at all is new in the
 * future direction or within the calendar window behind the cursor
 * (dates older than the window are skipped whole before this runs).
 * See the cursor module for why the marks, and not the bare tuple, are
 * what the filter reads.
 */
function isAfterCursor(
  position: CatchupPosition,
  cursor: LogCatchupCursor,
  windowCutoff: string,
): boolean {
  if (position.date === cursor.date) {
    const mark = cursor.shards[position.shardId];
    return mark === undefined || position.line > mark;
  }
  const marks =
    position.date < cursor.date ? cursor.days[position.date] : cursor.future[position.date];
  if (marks === undefined) {
    return position.date > cursor.date || position.date >= windowCutoff;
  }
  const mark = marks[position.shardId];
  return mark === undefined || position.line > mark;
}

/** The one-line text an entry contributes to the catch-up block. */
function entryText(entry: BrainLogEntry): string {
  for (const field of CATCHUP_BODY_FIELDS) {
    const value = entry.body[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return entry.eventType;
}

/**
 * One rendered line, never longer than {@link LOG_CATCHUP_MAX_LINE_CHARS}
 * (the ellipsis counts toward the cap). Applies to the composed text, so
 * a hostile `agent` label is bounded by the same guarantee as the body.
 */
function truncateRenderedLine(text: string): string {
  if (text.length <= LOG_CATCHUP_MAX_LINE_CHARS) return text;
  return `${text.slice(0, LOG_CATCHUP_MAX_LINE_CHARS - 1)}…`;
}

/** The attributed, neutralized label an entry renders under. */
function entryAgentLabel(entry: BrainLogEntry): string {
  const agent = typeof entry.agent === "string" ? entry.agent.trim() : "";
  return neutralizeSingleLine(agent.length > 0 ? agent : UNATTRIBUTED_AGENT_LABEL);
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no output.
  if (!logCatchupEnabled()) return;

  const disarm = armProcessCeiling({ ceilingMs: resolveHookCeilingMs() });
  try {
    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }

    const hookEventName =
      typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
        ? payload.hook_event_name
        : "SessionStart";
    // Default-closed: only an additionalContext-eligible event may emit.
    if (!isContextEventName(hookEventName)) return;

    const vault = resolveVault();
    if (vault === null) return;

    const self = resolveSelfIdentity();
    if (self === null) return;
    // The watermark is per identity, not per device: several runtimes
    // share this vault with different agent names, and whoever runs
    // first must not read the log past lines the others never saw.
    const cursor = readLogCatchupCursor(vault, self.value);
    // The calendar window behind the cursor date, computed once per run:
    // both the date-level skip below and the per-entry filter consult it,
    // and recomputing it per entry would re-derive the same date arithmetic
    // for every mark-less line in the log.
    const windowCutoff = cursor !== null ? windowCutoffDate(cursor.date) : "";

    // One walk over the log, oldest date first, starting at the oldest
    // date the cursor can still vouch about. `readLogDay` merges each
    // day's shards in (timestamp, shardId, line) order and also returns
    // each entry's index within its own shard's parsed entries
    // (`entryLines`), which is what both the filter and the watermark
    // need: appends only ever extend a shard file, so the parsed-entry
    // index never needs retraction, while a merge-order count scrambles
    // as soon as a shard's timestamps go backwards. The per-shard mark
    // is therefore the MAXIMUM parsed-entry index seen, not the last
    // merge position. The watermark rides the last entry seen, so a
    // trailing date with no entries cannot orphan the write.
    //
    // The directory is listed ONCE and the shard list handed to every
    // `readLogDay` (which filters it per date): listing per date would
    // pay one `readdirSync` + sort per day of history on every run.
    // Dates come from the same listing, so discovery and reading can
    // never disagree about what the log directory holds.
    const shardFiles = listLogShardFiles(vault);
    const dates = [...new Set(shardFiles.map((f) => f.date))].toSorted();
    //
    // The skip decision is per (date, shard), not per date: a shard that
    // syncs in late for an earlier date (the normal cross-device case)
    // must still surface, so the cursor keeps windowed marks
    // (LOG_CATCHUP_WINDOW_DATES dates back) and only a date both older
    // than the cursor date and outside that calendar window is skipped
    // whole. The bounds come from the calendar, not the recorded
    // `days` keys: a date that had no local file when the cursor parked
    // carries no marks, and keying the skip on the marks would drop its
    // late-arriving shards permanently. A FIRST run has no marks at all,
    // so its bound is its own calendar window behind the newest date
    // (`firstRunScanCutoffDate`); the older days are counted and
    // reported, never parsed.
    // The last scanned position dated today or earlier. A foreign line
    // stamped with a future-skewed date is newer in merge order than
    // everything real, so the watermark must not take its date - parked
    // past today, every real date under it would read as already-seen
    // (`date < cursor.date` with no window mark) and the lane would go
    // silent until the clock caught up. The clamp parks on the newest
    // position that exists as of today instead, and the skewed dates
    // keep their own marks in the cursor's `future` map below, so a
    // skewed line is shown once instead of every session until the
    // clock reaches its date.
    const today = new Date().toISOString().slice(0, 10);
    const firstRunCutoff = cursor === null ? firstRunScanCutoffDate(dates, today) : null;
    let unscannedOlderDays = 0;
    const collected: Array<{ entry: BrainLogEntry }> = [];
    let lastSeen: CatchupPosition | null = null;
    let lastSeenParked: CatchupPosition | null = null;
    // Null prototypes: shard ids are foreign input and DEVICE_ID_RE
    // admits Object.prototype member names ("constructor", "valueOf"),
    // which a plain {} inherits as if they were marks - the mark then
    // reads as a function, the write fails its shape validation and the
    // lane goes silent while rescanning history every session.
    let perDateMarks: Record<string, Record<string, number>> = Object.create(null);
    for (const date of dates) {
      if (
        cursor !== null &&
        date < cursor.date &&
        cursor.days[date] === undefined &&
        date < windowCutoff
      ) {
        continue;
      }
      if (firstRunCutoff !== null && date < firstRunCutoff) {
        unscannedOlderDays += 1;
        continue;
      }
      const { entries, entryShardIds, entryLines } = readLogDay(vault, date, shardFiles);
      const shardMarks: Record<string, number> = Object.create(null);
      perDateMarks[date] = shardMarks;
      for (let i = 0; i < entries.length; i++) {
        const shardId = entryShardIds[i] ?? "";
        const line = entryLines[i] ?? i;
        const mark = shardMarks[shardId];
        shardMarks[shardId] = mark === undefined || line > mark ? line : mark;
        const entry = entries[i]!;
        const position: CatchupPosition = { date, shardId, line };
        lastSeen = position;
        if (date <= today) lastSeenParked = position;
        // Self by payload attribution against the resolved identity,
        // both sides trimmed (resolveSelfIdentity trims its value); in
        // the device-id fallback also by shard, because that is the only
        // place the device id appears (see the SelfIdentity doc). A
        // configured agent name never consults the shard.
        const selfOwned =
          (entry.agent ?? "").trim() === self.value ||
          (self.fromDeviceFallback && shardId === self.value);
        if (!selfOwned && (cursor === null || isAfterCursor(position, cursor, windowCutoff))) {
          collected.push({ entry });
        }
      }
    }

    // Newest-first under the line cap; anything older is counted, not
    // rendered (the buildActivityTimeline limit/total shape). The char
    // cap then trims the same way - oldest lines drop first - and a
    // block that cannot fit even one line emits nothing and leaves the
    // cursor untouched, so nothing is silently dropped forever. A first
    // run's unscanned days are counted too and named in the header: a
    // day the window never parsed is not "shown later", it was not read
    // at all, and the count is the only honest way to say so - including
    // when the window held nothing foreign, where the count rides out on
    // a header-only block of its own (the emit below).
    const newest = collected.slice(-LOG_CATCHUP_MAX_LINES);
    let olderCount = collected.length - newest.length;
    const now = new Date();
    const render = (items: ReadonlyArray<{ entry: BrainLogEntry }>): string => {
      const activityItems: ReadonlyArray<ActivityItem> = items.map(({ entry }) => ({
        kind: "note",
        text: truncateRenderedLine(
          `${entryAgentLabel(entry)}: ${neutralizeSingleLine(entryText(entry))}`,
        ),
        timestamp: entry.timestamp,
      }));
      const notes: string[] = [];
      if (olderCount > 0) notes.push(`${olderCount} older not shown`);
      if (unscannedOlderDays > 0) notes.push(`${unscannedOlderDays} older day(s) not scanned`);
      // The lower bound the header names: a cursor run reads since its
      // last look, but a FIRST run has no last look - "since your last
      // read" would name a read that never happened, so the phrase says
      // where the bound actually comes from: the recent window.
      const scopePhrase = cursor === null ? "in the recent window" : "since your last read";
      const header =
        `Cross-agent catch-up: ${items.length} log line(s) from other agents ${scopePhrase}` +
        (notes.length > 0 ? ` (${notes.join("; ")})` : "") +
        ":";
      return fenceUntrustedContent(
        `${header}\n${renderActivityTimeline(activityItems, now)}`,
        CATCHUP_FENCE_ORIGIN,
      );
    };

    let shown = newest;
    let block = render(shown);
    while (block.length > LOG_CATCHUP_MAX_CHARS && shown.length > 0) {
      shown = shown.slice(1);
      olderCount += 1;
      block = render(shown);
    }
    // The emit happens only for a block with something in it - or, when
    // nothing foreign was collected but older days went unscanned, for
    // the header-only block that reports them: those days were not
    // parsed and will not be revisited once the cursor parks below, so
    // the count is the only report they ever get. The count cannot
    // collide with the nothing-fit-the-cap case (that arises only when
    // lines WERE collected, and holds the cursor instead), and the park
    // below is what keeps the header-only report to exactly one
    // emission - so the block emits only when that park will actually
    // happen (`lastSeen` set): a window whose every shard parses to
    // zero entries parks nothing, and repeating the report each
    // SessionStart over days no scan ever reaches would be a nag with
    // no end. Once a scan advances the watermark, the report rides out
    // exactly once on the park.
    if (shown.length > 0) {
      const out = {
        hookSpecificOutput: {
          hookEventName,
          additionalContext: block,
        },
      };
      process.stdout.write(JSON.stringify(out) + "\n");
    } else if (collected.length === 0 && unscannedOlderDays > 0 && lastSeen !== null) {
      const out = {
        hookSpecificOutput: {
          hookEventName,
          additionalContext: render([]),
        },
      };
      process.stdout.write(JSON.stringify(out) + "\n");
    }

    // The watermark lands AFTER the emit. It is written whenever the
    // scan actually advanced past lines - ALSO when nothing was
    // collected: every scanned line was self-authored or already seen,
    // so nothing is hidden by parking the cursor, and a solo agent that
    // never wrote it would rescan the whole history every SessionStart.
    // The only no-write cases: nothing was scanned at all
    // (`lastSeen === null`), or lines were collected but none fit the
    // cap (shown empty) - advancing past those would hide them forever.
    // The windowed days keep the marks of the newest
    // LOG_CATCHUP_WINDOW_DATES dates before the watermark date, so a
    // bounded slice of history stays per-shard resolvable and the file
    // cannot grow with the log.
    const nothingFitTheCap = collected.length > 0 && shown.length === 0;
    if (lastSeen !== null && !nothingFitTheCap) {
      // The clamp: park on the newest position dated today or earlier.
      // When every scanned line is future-dated there is no such
      // position, so the cursor parks on the bare date with no marks -
      // no real line is vouched for. The skewed dates themselves are
      // marked in `future` above, so their lines show once each instead
      // of every session, and what resurfaces until the clock catches
      // up is only a genuinely new line appended to a future date.
      const parked = lastSeenParked ?? { date: today, shardId: "", line: 0 };
      const days: Record<string, Record<string, number>> = {};
      const windowDates = Object.keys(perDateMarks)
        .filter((d) => d < parked.date)
        .toSorted()
        .slice(-LOG_CATCHUP_WINDOW_DATES);
      for (const d of windowDates) {
        const marks = perDateMarks[d]!;
        if (Object.keys(marks).length > 0) days[d] = marks;
      }
      // The scanned dates after the parked date keep their marks too -
      // the future-skewed dates the clamp refuses to park on. Without
      // them a skewed line, forever newest in merge order, would be
      // re-collected every session for the whole skew period. The OLDEST
      // future dates are the ones kept (the clock reaches them soonest);
      // a skew beyond the window resurfaces, the same bounded honesty as
      // the older-side window.
      const future: Record<string, Record<string, number>> = {};
      const futureDates = Object.keys(perDateMarks)
        .filter((d) => d > parked.date)
        .toSorted()
        .slice(0, LOG_CATCHUP_WINDOW_DATES);
      for (const d of futureDates) {
        const marks = perDateMarks[d]!;
        if (Object.keys(marks).length > 0) future[d] = marks;
      }
      writeLogCatchupCursor(vault, self.value, {
        date: parked.date,
        shardId: parked.shardId,
        line: parked.line,
        shards: perDateMarks[parked.date] ?? {},
        days,
        future,
      });
    }
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the session start must proceed regardless.
});
