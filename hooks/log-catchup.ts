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
 * Cursor. `(date, shardId, line)` watermark plus per-shard high-water
 * marks (hooks/lib/log-cursor-state.ts, overwrite-only derived state,
 * un-synced). The lane is a PURE read of the log: entries are discovered
 * through `listLogDates` and read through `readLogDay` and nothing is
 * ever appended to `Brain/log` - session-capture owns the lifecycle
 * event, and this lane must stay distinguishable from it.
 *
 * Bounded, fail-open. The per-lane caps are constants
 * (`policy/blocks/active.ts`); the block rides the shared untrusted
 * fence because other agents' log text is untrusted vault content; and
 * every path exits 0 - flag off is an immediate no-op with zero output.
 */

import {
  discoverConfig,
  isConfiguredAgentName,
  resolveAgentName,
  resolveDeviceId,
  resolveVault,
} from "../src/core/config.ts";
import { listLogDates, readLogDay } from "../src/core/brain/log-jsonl.ts";
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
  readLogCatchupCursor,
  writeLogCatchupCursor,
  type LogCatchupCursor,
} from "./lib/log-cursor-state.ts";

/** Env override for the opt-in flag, read before the config key. */
export const LOG_CATCHUP_ENV_FLAG = "OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED";

/** The `_brain.yaml` key the opt-in resolves from when the env is unset. */
export const LOG_CATCHUP_CONFIG_KEY = "log_catchup_enabled";

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

/** Label for a log line that carries no `agent` attribution. */
const UNATTRIBUTED_AGENT_LABEL = "unattributed";

/**
 * Whether the lane is on: the env flag first, then the config key, the
 * same env-then-config order every `resolveConfigFlag` reader uses.
 * Fail-soft - an unreadable config is off, not a crash.
 */
function logCatchupEnabled(): boolean {
  const env = process.env[LOG_CATCHUP_ENV_FLAG]?.trim();
  if (env) return env === "true" || env === "1";
  try {
    const value = discoverConfig().data[LOG_CATCHUP_CONFIG_KEY]?.trim();
    return value === "true" || value === "1";
  } catch {
    return false;
  }
}

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
  readonly timestamp: string;
}

/**
 * Whether an entry read at `position` is past the cursor. Dates after
 * the cursor date are all new; dates before are all seen; on the cursor
 * date the per-shard high-water marks decide - a shard with no mark yet
 * is entirely new, otherwise the entry is new when its line index is
 * past that shard's mark. See the cursor module for why the marks, and
 * not the bare tuple, are what the filter reads.
 */
function isAfterCursor(position: CatchupPosition, cursor: LogCatchupCursor): boolean {
  if (position.date > cursor.date) return true;
  if (position.date < cursor.date) return false;
  const mark = cursor.shards[position.shardId];
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
    const cursor = readLogCatchupCursor(vault);

    // One walk over the log, oldest date first, starting at the cursor
    // date when one exists. `readLogDay` merges each day's shards in
    // (timestamp, shardId, line) order; counting entries per shard as
    // they stream through reproduces each entry's shard-internal line
    // index, which is what both the filter and the watermark need. The
    // watermark snapshot rides the last entry seen, so a trailing
    // date with no entries cannot orphan the write.
    const collected: Array<{ entry: BrainLogEntry }> = [];
    let lastSeen: { position: CatchupPosition; marks: Record<string, number> } | null = null;
    let shardMarks: Record<string, number> = {};
    let lineCounts: Record<string, number> = {};
    for (const date of listLogDates(vault)) {
      if (cursor !== null && date < cursor.date) continue;
      const { entries, entryShardIds } = readLogDay(vault, date);
      shardMarks = {};
      lineCounts = {};
      for (let i = 0; i < entries.length; i++) {
        const shardId = entryShardIds[i] ?? "";
        // The running per-shard count IS the current entry's 0-based
        // index; the watermark marks keep the last-seen index, not the
        // count - the filter admits an entry strictly past the mark, so
        // storing the count would skip the very next appended line.
        const line = lineCounts[shardId] ?? 0;
        lineCounts[shardId] = line + 1;
        shardMarks[shardId] = line;
        const entry = entries[i]!;
        const position: CatchupPosition = {
          date,
          shardId,
          line,
          timestamp: entry.timestamp,
        };
        lastSeen = { position, marks: { ...shardMarks } };
        // Self by payload attribution against the resolved identity,
        // both sides trimmed (resolveSelfIdentity trims its value); in
        // the device-id fallback also by shard, because that is the only
        // place the device id appears (see the SelfIdentity doc). A
        // configured agent name never consults the shard.
        const selfOwned =
          (entry.agent ?? "").trim() === self.value ||
          (self.fromDeviceFallback && shardId === self.value);
        if (!selfOwned && (cursor === null || isAfterCursor(position, cursor))) {
          collected.push({ entry });
        }
      }
    }

    if (collected.length === 0) return;

    // Newest-first under the line cap; anything older is counted, not
    // rendered (the buildActivityTimeline limit/total shape). The char
    // cap then trims the same way - oldest lines drop first - and a
    // block that cannot fit even one line emits nothing and leaves the
    // cursor untouched, so nothing is silently dropped forever.
    const newest = collected.slice(-LOG_CATCHUP_MAX_LINES);
    let olderCount = collected.length - newest.length;
    const now = new Date();
    const render = (items: ReadonlyArray<{ entry: BrainLogEntry }>): string => {
      const activityItems: ReadonlyArray<ActivityItem> = items.map(({ entry }) => ({
        kind: "note",
        text: `${entryAgentLabel(entry)}: ${neutralizeSingleLine(entryText(entry))}`,
        timestamp: entry.timestamp,
      }));
      const header =
        `Cross-agent catch-up: ${items.length} log line(s) from other agents since your last read` +
        (olderCount > 0 ? ` (${olderCount} older not shown)` : "") +
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
    if (shown.length === 0) return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: block,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");

    // The watermark lands AFTER the emit, and only after an emit: a run
    // with nothing to show writes nothing, and a crash between the emit
    // and the write replays history next session rather than skipping it.
    if (lastSeen !== null) {
      writeLogCatchupCursor(vault, {
        date: lastSeen.position.date,
        shardId: lastSeen.position.shardId,
        line: lastSeen.position.line,
        shards: lastSeen.marks,
      });
    }
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the session start must proceed regardless.
});
