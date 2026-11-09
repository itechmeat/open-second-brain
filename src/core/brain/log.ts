/**
 * Brain log (`Brain/log/<YYYY-MM-DD>.md`) parser and appender.
 *
 * The log is the audit trail of every state-changing Brain operation.
 * One Markdown file per UTC day; events appear as level-2 headings
 * formatted as `## <HH:MM:SS>Z — <event-kind>` followed by a bullet
 * list of `- <key>: <value>` lines. Lists are encoded as repeated
 * `- key:` entries with sub-bullets (the simple parser accepts both
 * `- key: value` and the indented sub-bullet form for arrays).
 *
 * Two operations:
 *
 *   - {@link parseLogDay} reads one day's file and returns an array of
 *     {@link BrainLogEntry}. Malformed entries (broken header, invalid
 *     bullet shape) are skipped and surfaced via the `warnings` array
 *     so the dream loop and digest never blow up on a partially-edited
 *     log. Returns an empty array when the file does not exist.
 *
 *   - {@link appendLogEvent} writes a new event to today's log. If the
 *     file is absent, it is created with a canonical frontmatter
 *     header (`kind: brain-log`, `date`, `tags`) and the title line.
 *     Subsequent appends preserve previous bytes verbatim — the
 *     log is append-only. Each event is ONE append per file under the
 *     log directory lock (`log-append-io.ts`): the appender reads only
 *     the shard's tail (the previous chain link, the trailing
 *     whitespace), never the whole day, which it used to read and
 *     rewrite through a temp file for every event.
 *
 * Every appended event carries an `origin_channel` bullet beside the
 * `agent` one: the server-derived channel of the process that wrote it
 * (`src/core/origin-channel.ts`). Events written before that shipped
 * carry no such bullet and are never rewritten to add one.
 *
 * Every appended JSONL row also carries a per-shard hash chain
 * ({@link LOG_CHAIN_FIELDS}, who-wrote-what Task E): once the log is the
 * attribution record for every write, a line someone deleted or edited
 * has to be detectable. The markdown twin is a derived rendering of the
 * same events and is deliberately NOT chained - a human-editable view is
 * the wrong thing to hold to a hash, and the JSONL sidecar is the
 * machine-primary surface every reader already prefers.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { appendSeparated, scanLinesFromEnd } from "./log-append-io.ts";
import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import {
  brainDirs,
  brainDirsForWrite,
  logPath,
  logShardJsonlPath,
  logShardPath,
  validateIsoDate,
} from "./paths.ts";
import { WRITE_LANE } from "./freeze-marker.ts";
import { isValidDeviceId } from "../config.ts";
import { listShardedFiles, resolveAppendShardId } from "./ledger-shards.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import { routeWrite, type StoreWriteError } from "../store/store-write.ts";
import { acquireDirLock } from "../store/local-lock.ts";
import { logEventRecord } from "../store/dual-write-records.ts";
import { operationPrivacy, type PrivacyVerdict } from "../store/operation-privacy.ts";
import { logRefsNamePrivatePage } from "../store/reference-privacy.ts";
import { ORIGIN_CHANNEL_FIELD, originChannelStamp } from "../origin-channel.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_LOG_EVENT_KIND_SET, type BrainLogEventKind } from "./types.ts";
import { PREF_ID_PREFIX } from "./dream-plan.ts";

/** A topic that can stand as a preference slug: no path separator, no dot run. */
const RECONCILE_TOPIC_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// ----- Public types ---------------------------------------------------------

/** Parsed bullet payload of a single log entry. */
export type BrainLogEntryPayload = Readonly<Record<string, string | ReadonlyArray<string>>>;

/**
 * A parsed log entry. `timestamp` is the full ISO-8601 UTC moment
 * reconstructed from the file's `date` and the heading's `HH:MM:SS`
 * stamp. `body` keeps the bullet payload verbatim (string for single
 * values, string[] for repeated keys).
 */
export interface BrainLogEntry {
  readonly timestamp: string;
  readonly eventType: BrainLogEventKind;
  readonly agent?: string;
  readonly body: BrainLogEntryPayload;
}

/** Warning surfaced by {@link parseLogDay} for a malformed sub-block. */
export interface BrainLogParseWarning {
  readonly path: string;
  readonly lineNumber: number;
  readonly message: string;
}

export interface ParseLogDayResult {
  readonly entries: ReadonlyArray<BrainLogEntry>;
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
}

/** Where {@link appendLogEvent} put the event. */
export interface AppendLogEventResult {
  /**
   * The file that now holds the event: the Markdown day page on an
   * unswitched machine, the store shard of its `log-event` record on a
   * store-only one, and the empty string when a fail-open store write did
   * not land.
   */
  readonly logPath: string;
  /** `legacy`: the vault's log day files (plus the dual write); `store`: the store only. */
  readonly stored: "legacy" | "store";
  /** The store record id on a store-only machine, else `null`. */
  readonly recordId: string | null;
  /**
   * The store shard of that record as `<partition>/<partition-relative
   * path>` (`shared/log/<device>/<YYYY-MM>.jsonl`) on a store-only
   * machine, else `null`.
   */
  readonly storeShard: string | null;
  /**
   * Why a fail-open store write did not land (the error doctor also
   * counts); absent when the event landed. Branch on this, never on an
   * empty `logPath`.
   */
  readonly failed?: StoreWriteError;
}

/**
 * The wikilink a retirement record stamps as `retired_by`, naming the
 * log shard THIS device appends to for `date`.
 *
 * The link and the event it cites must land on the same file. The
 * appender resolves its shard with {@link resolveAppendShardId}; a link
 * built from the bare date (the pre-shard shape) names a file this
 * device never writes once a device id is configured, and the doctor
 * reads the retirement's provenance as a broken link. This helper is
 * the one place that spelling exists, so a writer cannot drift from the
 * appender: with the empty shard id it emits the exact historical
 * `[[Brain/log/<date>]]`, with a device id `[[Brain/log/<date>.<id>]]`
 * - the Obsidian basename of the file {@link logShardPath} writes.
 *
 * Pass `deviceId` explicitly when the caller already resolved the shard
 * for its own `appendLogEvent` call (merge does), so one resolution
 * feeds both writes. Omitted, the helper resolves the same way the
 * appender defaults to. Historical records are never rewritten: only
 * links written after this ship carry the shard segment.
 */
export function logShardWikilink(date: string, deviceId?: string): string {
  const shardId = deviceId ?? resolveAppendShardId();
  if (shardId !== "" && !isValidDeviceId(shardId)) {
    throw new Error(
      `logShardWikilink: invalid deviceId ${JSON.stringify(shardId)} - ` +
        "expected a lowercase slug matching the device_id config shape",
    );
  }
  return shardId === "" ? `[[Brain/log/${date}]]` : `[[Brain/log/${date}.${shardId}]]`;
}

// ----- Constants ------------------------------------------------------------

// `## HH:MM:SSZ — <kind>` — both the em dash (—) and the hyphen are
// accepted to tolerate hand-edits. The mandatory `Z` after the time
// reflects the design doc's "UTC time" formatting (§5.5 example).
const HEADER_RE = /^##\s+(\d{2}):(\d{2}):(\d{2})Z\s+[—-]\s+([a-z][a-z0-9-]*)\s*$/;

// Bullet keys are limited to ASCII identifiers (with `_`) plus
// hyphens. We accept any text after the colon, including wikilinks,
// quoted strings, and multi-word values — the parser does not try to
// interpret them, only to record the key/value split.
const BULLET_RE = /^-\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

// Sub-bullets nest underneath a parent bullet that ends with a bare
// colon (no value). The leading whitespace varies in real-world
// edits; we accept 2-or-more spaces or one or more tabs.
const SUB_BULLET_RE = /^(?:\s{2,}|\t+)-\s+(.+)$/;

// ----- Public API -----------------------------------------------------------

/**
 * Parse `Brain/log/<date>.md` if present. Returns an empty array when
 * the file does not exist — there is no Brain log for that day yet.
 *
 * `parseLogDay` is tolerant of garbage: malformed headers, unknown
 * event kinds, or stray bullets get reported as warnings and the rest
 * of the file is still returned. This keeps the dream loop alive even
 * when a manual edit corrupts a single block.
 */
export function parseLogDay(vault: string, date: string): ParseLogDayResult {
  const validDate = validateIsoDate(date);
  return parseLogDayFile(vault, validDate, logPath(vault, validDate));
}

/**
 * Parse one specific log markdown file for `date`. The per-device
 * shard layout (Memory Integrity Suite) means a day can have several
 * markdown files (`<date>.md`, `<date>.<deviceId>.md`); the shard
 * readers in log-jsonl.ts call this once per file and merge.
 */
export function parseLogDayFile(vault: string, date: string, path: string): ParseLogDayResult {
  const validDate = validateIsoDate(date);
  if (!existsSync(path)) {
    return { entries: [], warnings: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries: [], warnings: [] };
  }

  const entries: BrainLogEntry[] = [];
  const warnings: BrainLogParseWarning[] = [];

  // Strip the YAML frontmatter and the top-level title to expose the
  // event blocks. We do this with a manual scan rather than the
  // frontmatter parser because we need the raw line numbers for the
  // warning trail.
  const lines = text.split(/\r?\n/);
  let cursor = 0;
  if (lines[0]?.trimEnd() === "---") {
    cursor = 1;
    while (cursor < lines.length && lines[cursor]?.trimEnd() !== "---") {
      cursor++;
    }
    if (cursor < lines.length) cursor++; // skip closing '---'
  }

  // Each event block starts at a `## ...` line and ends at the next
  // `## ...` or EOF. We collect them in encounter order so the
  // caller's "stable order" guarantee is honoured.
  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (!line.startsWith("## ")) {
      cursor++;
      continue;
    }
    const headerLineNumber = cursor + 1;
    const header = HEADER_RE.exec(line);
    if (!header) {
      warnings.push({
        path,
        lineNumber: headerLineNumber,
        message: `malformed event header: ${line}`,
      });
      cursor++;
      continue;
    }
    const hh = header[1]!;
    const mm = header[2]!;
    const ss = header[3]!;
    const kindStr = header[4]!;
    if (!BRAIN_LOG_EVENT_KIND_SET.has(kindStr)) {
      warnings.push({
        path,
        lineNumber: headerLineNumber,
        message: `unknown event kind: ${kindStr}`,
      });
      cursor++;
      // Skip the malformed block's body so we don't try to parse its
      // bullets as a top-level event.
      while (cursor < lines.length && !lines[cursor]!.startsWith("## ")) {
        cursor++;
      }
      continue;
    }

    // Read bullets until the next event header or EOF.
    cursor++;
    const blockStart = cursor;
    while (cursor < lines.length && !lines[cursor]!.startsWith("## ")) {
      cursor++;
    }
    const blockEnd = cursor;

    const { payload, blockWarnings } = parseBulletBlock(
      lines.slice(blockStart, blockEnd),
      blockStart + 1,
      path,
    );
    for (const w of blockWarnings) warnings.push(w);

    entries.push({
      timestamp: `${validDate}T${hh}:${mm}:${ss}Z`,
      eventType: kindStr as BrainLogEventKind,
      agent: typeof payload.agent === "string" ? payload.agent : undefined,
      body: Object.freeze(payload),
    });
  }

  return { entries, warnings };
}

/**
 * Append a new event to the log for the day of `event.timestamp`. If
 * the log file does not yet exist, it is created with the canonical
 * frontmatter + title header; otherwise the existing file is read,
 * concatenated with the new block, and written back atomically. We
 * never edit prior blocks — append-only is the contract.
 *
 * Two writes happening at the same UTC second receive the same
 * `<HH:MM:SS>` header; the on-disk order is the order of calls to
 * this function. That's the stability guarantee the test suite asks
 * for.
 */
/** Longest wait for the log directory lock before an append gives up. */
export const LOG_LOCK_WAIT_MS = 2_000;

/**
 * Acquire the per-log-day directory lock with a bounded wait.
 *
 * `proper-lockfile`'s sync API refuses the `retries` option (it cannot
 * block the event loop on a callback), so the wait is spelled out in
 * `acquireDirLock` (`store/local-lock.ts`): jittered, growing sleeps
 * while the lock is held, up to {@link LOG_LOCK_WAIT_MS}, then an
 * `ELOCKED` refusal. A Windows lock directory still being deleted by the
 * previous holder counts as held, not as a permission error. Any other
 * error is rethrown immediately (permission, fs corruption, …).
 *
 * Exported so the fixtures that reproduce log-lock contention hold the
 * SAME lock the appender takes (the attestation digest and verify
 * suites): if this site or its options move, the fixtures fail loudly
 * instead of silently reproducing nothing.
 *
 * Two seconds is short enough to feel synchronous to a coding agent and
 * long enough for a writer to get its turn among several agents
 * appending at once on a host whose fsync is slow (Windows), where a
 * fixed handful of 50 ms retries lost every round to the writers that
 * re-took the lock the moment they released it.
 */
export function acquireLogLock(logDir: string): () => void {
  return acquireDirLock(logDir, {
    staleMs: 10_000,
    budgetMs: LOG_LOCK_WAIT_MS,
    label: "log lock",
    remedy: "another process is appending to the Brain log; retry the write",
  });
}

export interface AppendLogEventOptions {
  /**
   * Per-device shard id (Memory Integrity Suite). Defaults to
   * {@link resolveAppendShardId}, which reads the device-local config and
   * falls back to the empty string - the legacy un-sharded
   * `<date>.jsonl` / `<date>.md` pair - when the config cannot be
   * resolved. That fallback and the reasoning behind it now live in
   * `ledger-shards.ts`, shared with every other append-only ledger.
   *
   * Passing the empty string here forces the legacy pair explicitly.
   */
  readonly deviceId?: string;
  /**
   * Brain store dual write: the privacy verdict of the operation this
   * event belongs to (`store/operation-privacy.ts`). A private verdict
   * sends the event's store record to `private` even when the event names
   * no private page; an event that names one goes there regardless.
   * Judged only when dual writes are on.
   */
  readonly storePrivate?: PrivacyVerdict;
  /**
   * Hooks and other best-effort paths (design D14 item 1): on a
   * store-only machine a store failure is counted in the device-local
   * store-write status and the call returns instead of throwing. Without
   * it a store-only failure throws `StoreWriteError` with its remedy. No
   * effect on an unswitched machine, whose legacy append still throws as
   * before and whose dual write never does.
   */
  readonly failOpen?: boolean;
  /** The machine config the store-only switch and the store root come from. */
  readonly configPath?: string;
}

/**
 * Fields of a log event body that are stamps rather than page references:
 * the server-derived origin channel. The writing `agent` is NOT opaque: a
 * caller supplies it as a free string, so it is judged like any other
 * field. An operation that judges the event it is about to append judges
 * its body with these same opaque fields ({@link logEventPrivacyContent}),
 * so its verdict covers the appender's own.
 */
export const LOG_EVENT_OPAQUE_FIELDS: ReadonlySet<string> = new Set([ORIGIN_CHANNEL_FIELD]);

/** A log event body as content an operation's privacy verdict judges. */
export function logEventPrivacyContent(body: Readonly<Record<string, unknown>>): {
  readonly value: unknown;
  readonly opaque: ReadonlySet<string>;
} {
  return { value: body, opaque: LOG_EVENT_OPAQUE_FIELDS };
}

export function appendLogEvent(
  vault: string | null,
  event: BrainLogEntry,
  opts: AppendLogEventOptions = {},
): AppendLogEventResult {
  if (!BRAIN_LOG_EVENT_KIND_SET.has(event.eventType)) {
    throw new Error(
      `appendLogEvent: unknown event kind '${event.eventType}' — must be one of ${Object.values(
        BRAIN_LOG_EVENT_KIND,
      ).join(", ")}`,
    );
  }
  let deviceId: string;
  if (opts.deviceId !== undefined) {
    if (opts.deviceId !== "" && !isValidDeviceId(opts.deviceId)) {
      throw new Error(
        `appendLogEvent: invalid deviceId ${JSON.stringify(opts.deviceId)} - ` +
          "expected a lowercase slug matching the device_id config shape",
      );
    }
    deviceId = opts.deviceId;
  } else {
    deviceId = resolveAppendShardId();
  }
  // Parse the timestamp once to extract date + HHMMSS deterministically.
  // We deliberately do not accept Date objects: the caller controls the
  // canonical representation so two calls with identical input produce
  // byte-identical output (idempotency requirement).
  const ts = parseIsoUtc(event.timestamp);
  const topLevelAgent = (event as { agent?: unknown }).agent;
  const withAgent =
    typeof topLevelAgent === "string" && typeof event.body["agent"] !== "string"
      ? { ...event.body, agent: topLevelAgent }
      : { ...event.body };
  // The server-derived origin channel (Unit C), folded into the body the
  // same way `agent` is so both surfaces this appender writes carry it
  // and `parseLogDay` reads it back with no parser change.
  //
  // Assigned LAST and unconditionally: `agent` yields to a body key
  // because the caller may legitimately name a different agent for the
  // event than for the call, but the channel is derived from the process
  // and a body that spells it is a caller naming its own provenance -
  // the one thing this field exists not to be.
  const eventBody: BrainLogEntryPayload = Object.freeze({
    ...withAgent,
    [ORIGIN_CHANNEL_FIELD]: originChannelStamp(),
  });
  const diskEvent: BrainLogEntry = { ...event, body: eventBody };

  // The store record (the dual write on an unswitched machine, the only
  // write on a store-only one, design D14 item 1). An event that names a
  // private page (a private preference's id and principle, a private
  // note's link, in any field and inside free text), whose body carries a
  // `<private>` region or the placeholder a stripped one leaves, or that
  // belongs to a private operation goes to `private` only. A reconcile
  // event's guessed preference is judged only when its page exists
  // (`logRefsNamePrivatePage`). Store-only records carry no hash chain:
  // store integrity is the record sums plus partition digests (D14 item
  // 10); the chain stays a property of the legacy day files.
  const storeRecord = (): DualWriteRecord => {
    const guessed = reconcileTopicPreferenceId(diskEvent);
    const isPrivate = operationPrivacy(vault, {
      inherit: [
        opts.storePrivate,
        () => guessed !== undefined && logRefsNamePrivatePage(vault, [guessed], guessed),
      ],
      content: [logEventPrivacyContent(diskEvent.body)],
    });
    return logEventRecord(diskEvent, isPrivate());
  };

  const routed = routeWrite({
    legacy: () => appendLegacyLogEvent(requireLegacyVault(vault), diskEvent, ts, deviceId),
    store: storeRecord,
    context: {
      vault,
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    },
    ...(opts.failOpen === true ? { failOpen: true } : {}),
  });
  if (routed.mode === "legacy") {
    return { logPath: routed.value, stored: "legacy", recordId: null, storeShard: null };
  }
  const landed = routed.records[0];
  if (landed === undefined) {
    return {
      logPath: "",
      stored: "store",
      recordId: null,
      storeShard: null,
      ...(routed.failed !== undefined ? { failed: routed.failed } : {}),
    };
  }
  // The shard path ends in its partition-relative path, below the
  // partition folder whose name is the partition.
  const partitionDir = landed.path.slice(0, landed.path.length - landed.rel.length - 1);
  return {
    logPath: landed.path,
    stored: "store",
    recordId: landed.record.id,
    storeShard: `${basename(partitionDir)}/${landed.rel}`,
  };
}

/** An unswitched machine has a legacy tree, so it has a vault. */
function requireLegacyVault(vault: string | null): string {
  if (vault === null || vault.trim() === "") {
    throw new Error("appendLogEvent: the legacy log needs a vault");
  }
  return vault;
}

/**
 * The legacy append (unswitched machines): one JSONL row with its hash
 * chain link and one Markdown block, under the log directory lock.
 * Returns the Markdown day page's path.
 */
function appendLegacyLogEvent(
  vault: string,
  diskEvent: BrainLogEntry,
  ts: { readonly date: string; readonly hms: string },
  deviceId: string,
): string {
  const path = logShardPath(vault, ts.date, deviceId);
  const jsonlPath = logShardJsonlPath(vault, ts.date, deviceId);
  // The AUDIT lane (who-wrote-what, Task C). This appender is one of the
  // two callers that skip the freeze check, and it is the reason the lane
  // exists at all: `freeze`, `unfreeze` and `write-refused` are events
  // about a frozen vault, so a freeze that silenced the log would erase
  // the record of itself and of every write it refused. The identity
  // assertion still runs - a log line landing in the wrong store is as
  // wrong as a note landing there.
  const logDir = brainDirsForWrite(vault, undefined, WRITE_LANE.audit).log;

  // §23 (v0.10.8): each event lands in both `<date>.jsonl` (machine
  // surface, primary for `readLogDay`) and `<date>.md` (human-facing
  // Obsidian view). JSONL is written first so a partial failure
  // (e.g. ENOSPC between the two writes) leaves the machine-readable
  // source authoritative — discipline-report and future tooling keep
  // returning the correct counts; only the human Obsidian view lags
  // until the next successful append rewrites the markdown.
  //
  // The pair shares one directory-level lock so two concurrent
  // appenders cannot interleave each other's halves.
  mkdirSync(logDir, { recursive: true });
  const release = acquireLogLock(logDir);

  try {
    // ---- JSONL sidecar (machine surface, primary) ---------------------
    // One row per event. The row is a deterministic projection of the
    // markdown body so the markdown and JSONL representations describe
    // the same event byte-for-byte after JSON.parse.
    // The chain (Task E) needs only the previous link: the shard is read
    // backwards from its end and the scan stops at the newest line that
    // carries one, so the cost is the tail, not the day. Holding the lock
    // is what makes the link CORRECT - two appenders reading the same
    // head would otherwise write two lines claiming the same predecessor.
    //
    // A torn last line (a crash mid-append, no trailing newline) is
    // skipped by the head scan exactly as before, and `appendSeparated`
    // starts the new row on its own line, so the fragment stays one
    // malformed line the reader warns about instead of corrupting the
    // row written after it.
    const line = renderJsonlLine(diskEvent, scanLinesFromEnd(jsonlPath, chainHashOfLine));
    appendSeparated(jsonlPath, `${line}\n`, "\n", `${line}\n`);

    // ---- Markdown (human surface) -------------------------------------
    // One blank line between blocks and a single trailing newline, the
    // same bytes the former whole-file rewrite produced; the block always
    // ends in a newline, so the file always does too.
    const block = renderEventBlock(diskEvent, ts.hms);
    appendSeparated(path, block, "\n\n", renderFileHeader(ts.date) + "\n" + block);
  } finally {
    release();
  }
  return path;
}

// ----- Renderers ------------------------------------------------------------

/** The header of a log day page: its frontmatter and title line. */
export function renderLogDayHeader(date: string): string {
  return renderFileHeader(date);
}

function renderFileHeader(date: string): string {
  // Frontmatter is hand-rendered (not via `formatFrontmatter`) because
  // the tags array must be a stable, comma-separated inline list, and
  // we need byte-deterministic output for the test suite.
  const lines: string[] = [
    "---",
    "kind: brain-log",
    `date: ${date}`,
    "tags: [brain, brain/log]",
    "---",
    "",
    `# Brain log — ${date}`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * One parsed entry rendered as the markdown block {@link appendLogEvent}
 * writes for it, so a reader that drops or trims entries can serve the
 * rest in the shape the shard would have had without them.
 */
export function renderLogEntryBlock(entry: BrainLogEntry): string {
  return renderEventBlock(entry, parseIsoUtc(entry.timestamp).hms);
}

function renderEventBlock(event: BrainLogEntry, hms: string): string {
  const lines: string[] = [`## ${hms}Z — ${event.eventType}`];
  // Stable iteration order: keys in the order they appear in the
  // payload object. The caller is responsible for the order they care
  // about; we don't sort because some events benefit from a logical
  // grouping (e.g. `run_id` first).
  for (const [key, value] of Object.entries(event.body)) {
    if (Array.isArray(value)) {
      // Repeated keys are encoded as a parent bullet with the bare key
      // followed by indented sub-bullets — matches the design-doc
      // example for `dream.new_unconfirmed`.
      lines.push(`- ${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`- ${key}: ${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the JSONL projection of an event (§23, v0.10.8; chained by
 * who-wrote-what Task E). The row shape is
 * `{ ts, kind, payload, prev, h }` where `payload` is a one-to-one map
 * of the markdown body bullets. Array bullets become JSON arrays;
 * scalar bullets become JSON strings. The function never sorts keys,
 * so byte-identical inputs plus a byte-identical `prev` produce
 * byte-identical rows.
 *
 * The chain fields come LAST so the projection the readers have always
 * consumed still reads as the head of the row, and `readJsonl` ignores
 * them entirely - the chain is an audit surface, never a read gate.
 */
function renderJsonlLine(event: BrainLogEntry, prev: string | null): string {
  const payload: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(event.body)) {
    payload[key] = value;
  }
  const ts = event.timestamp;
  const kind: string = event.eventType;
  return JSON.stringify({
    ts,
    kind,
    payload,
    [LOG_CHAIN_FIELDS.prev]: prev,
    [LOG_CHAIN_FIELDS.h]: logChainHash(prev, ts, kind, payload),
  });
}

// ----- The per-shard hash chain ---------------------------------------------

/**
 * The two chain-carrying keys of a JSONL log row, named once because
 * three surfaces spell them: the renderer above, the head scanner
 * below, and the verifier in `log-chain.ts`.
 *
 * They are the ONLY keys the chain adds. Everything else a row carries
 * is hashed, so a field a future writer adds to the projection is
 * covered by the chain automatically.
 */
export const LOG_CHAIN_FIELDS = Object.freeze({
  /** The preceding chained line's {@link LOG_CHAIN_FIELDS.h}, `null` at genesis. */
  prev: "prev",
  /** This line's chain hash. */
  h: "h",
} as const);

/**
 * The chain hash a row carries: sha256 over the canonical JSON of its
 * link plus its whole projection.
 *
 * `prev` is inside the hash rather than beside it, which is what makes
 * the structure a chain: editing any earlier line changes every later
 * hash, so a tampered history cannot be re-linked without rewriting the
 * whole shard from the edit forward.
 *
 * Defined here rather than in `log-chain.ts` even though the verifier is
 * that module's subject: the appender needs it, `log-chain.ts` needs the
 * shard listing from `log-jsonl.ts`, and `log-jsonl.ts` needs this
 * module's parser - so a hash living with the verifier would close an
 * import cycle. `log-chain.ts` re-exports it, so callers reading about
 * the chain find it where the design puts it.
 */
export function logChainHash(
  prev: string | null,
  ts: string,
  kind: string,
  payload: Readonly<Record<string, string | ReadonlyArray<string>>>,
): string {
  return sha256Hex(canonicalJson({ prev, ts, kind, payload }));
}

/**
 * The chain head of a shard already read into memory: the `h` of the
 * LAST line that carries one, or `null` when no line does.
 *
 * Scanned from the end and stopped at the first hit, so an append costs
 * one JSON parse rather than one per line of the day. Lines that carry
 * no `h` are the pre-chain history of a vault that upgraded mid-day;
 * they are skipped rather than treated as a break, and the first chained
 * line written after them anchors the shard's chain with `prev: null`.
 * A line that will not parse is skipped for the same reason - the
 * appender's job is to link to the newest link that exists, and naming
 * the damage is the verifier's.
 */
function lastChainHash(jsonl: string): string | null {
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = chainHashOfLine(lines[i]!);
    if (h !== null) return h;
  }
  return null;
}

/**
 * The chain hash one JSONL line carries, or `null` for a blank, an
 * unparseable or a pre-chain line. The per-line rule of
 * {@link lastChainHash}, shared with the appender's backward file scan
 * so the two can never disagree about which line is the head.
 */
function chainHashOfLine(line: string): string | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const h = (parsed as Record<string, unknown>)[LOG_CHAIN_FIELDS.h];
  return typeof h === "string" && h !== "" ? h : null;
}

/**
 * The JSONL-only half of the log's shard grammar, for the head collector
 * below. The recogniser itself lives in `ledger-shards.ts` like every
 * other ledger's; the markdown twin is deliberately absent here because
 * it is not chained and carries no head to collect. Exported so the
 * attestation record reader validates manifest shard names against the
 * ONE grammar the collector names them with - a second spelling would
 * let the two drift apart.
 */
export const LOG_HEAD_GRAMMAR = Object.freeze({
  base: "\\d{4}-\\d{2}-\\d{2}",
  extensions: Object.freeze(["jsonl"]),
});

/**
 * Every JSONL shard's chain head, keyed by the shard's file name.
 *
 * Exported for the attestation manifest (delivery trust): a signed
 * record binds the log state, and the log shards per device per day, so
 * what gets attested is this MAP and never a single head - there is no
 * total order across shards, and one file's head says nothing about
 * another's.
 *
 * The key is the shard's FILE NAME (`2026-06-03.jsonl`,
 * `2026-06-03.device-b.jsonl`) rather than the bare device id the appender
 * resolves: the same device writes one shard per day, so the device id
 * alone would collide in a map that spans days. The file name is the
 * shard's unique, stable identity in `Brain/log/`, and it is what a
 * verifier needs to re-resolve the head to bytes.
 *
 * Each head is read under the SAME per-directory lock the appender takes
 * ({@link acquireLogLock}), for the reason documented at the append site:
 * a head read without the lock can name a line the appender has already
 * superseded, and a signature computed over it would vouch for state that
 * never existed as a whole. A store that cannot be locked or read refuses
 * by throwing, exactly as {@link appendLogEvent} does - refusing to attest
 * is the honest answer, and a silent empty map would be a signature over
 * nothing. Shards whose lines carry no chain hash at all (pre-chain
 * history) contribute no entry; their names are still covered by the
 * attested ledger inventory, so nothing escapes the manifest.
 *
 * Returns `{}` for a vault with no log directory - there is nothing to
 * attest, which is a fact about the store, not a failure.
 */
export function collectLogShardHeads(vault: string): Readonly<Record<string, string>> {
  const logDir = brainDirs(vault).log;
  if (!existsSync(logDir)) return {};
  const heads: Record<string, string> = {};
  const release = acquireLogLock(logDir);
  try {
    // The listing runs INSIDE the lock, beside the head reads it feeds:
    // a shard created between an outside listing and the lock (a day
    // rollover, a new device's first append) would escape the map and a
    // signed manifest would vouch for a log that omits it.
    const files = listShardedFiles(logDir, LOG_HEAD_GRAMMAR);
    for (const file of files) {
      const head = lastChainHash(readFileSync(file.path, "utf8"));
      if (head !== null) heads[file.name] = head;
    }
  } finally {
    release();
  }
  return heads;
}

// ----- Bullet block parser --------------------------------------------------

interface ParseBulletResult {
  readonly payload: Record<string, string | ReadonlyArray<string>>;
  readonly blockWarnings: ReadonlyArray<BrainLogParseWarning>;
}

function parseBulletBlock(
  lines: ReadonlyArray<string>,
  startLineNumber: number,
  path: string,
): ParseBulletResult {
  const payload: Record<string, string | ReadonlyArray<string>> = {};
  const blockWarnings: BrainLogParseWarning[] = [];

  // We walk the block linearly. Top-level bullets either carry their
  // value inline (`- key: value`) or open a sub-bullet list (`- key:`
  // followed by `  - <item>` lines). We close the current sub-list as
  // soon as we hit either another top-level bullet or a blank line.
  let cursor = 0;
  let currentListKey: string | null = null;
  let currentList: string[] | null = null;

  const flushList = (): void => {
    if (currentListKey !== null && currentList !== null) {
      payload[currentListKey] = currentList;
    }
    currentListKey = null;
    currentList = null;
  };

  while (cursor < lines.length) {
    const raw = lines[cursor]!;
    const lineNumber = startLineNumber + cursor;
    const trimmed = raw.trim();
    if (trimmed === "") {
      flushList();
      cursor++;
      continue;
    }
    const sub = SUB_BULLET_RE.exec(raw);
    if (sub && currentList !== null) {
      currentList.push(sub[1]!.trim());
      cursor++;
      continue;
    }
    const bullet = BULLET_RE.exec(raw);
    if (!bullet) {
      blockWarnings.push({
        path,
        lineNumber,
        message: `malformed bullet: ${raw}`,
      });
      flushList();
      cursor++;
      continue;
    }
    flushList();
    const key = bullet[1]!;
    const value = bullet[2]!;
    if (value === "") {
      currentListKey = key;
      currentList = [];
    } else {
      payload[key] = value;
    }
    cursor++;
  }
  flushList();
  return { payload, blockWarnings };
}

// ----- Time utilities ------------------------------------------------------

interface IsoUtcParts {
  readonly date: string;
  readonly hms: string;
}

/**
 * Parse an ISO-8601 UTC timestamp into its date and `HH:MM:SS` parts.
 * Accepts both `2026-05-14T10:42:00Z` and `2026-05-14T10:42:00.123Z`
 * forms; sub-second precision is truncated to seconds because the log
 * heading shape is `HH:MM:SS` only.
 */
function parseIsoUtc(timestamp: string): IsoUtcParts {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(timestamp);
  if (!m) {
    throw new Error(
      `appendLogEvent: timestamp must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ); got ${JSON.stringify(timestamp)}`,
    );
  }
  return { date: m[1]!, hms: `${m[2]!}:${m[3]!}:${m[4]!}` };
}

/**
 * Every artifact one log entry names, as references an
 * {@link ArtifactRefView} can resolve.
 *
 * A log entry is the one record shape whose SUBJECT is another artifact:
 * it says what was applied to which preference, over which page. Two
 * surfaces filter log rows by what they name - the `osb://log/{date}`
 * resource and `brain_query` - and a second copy of the answer would be
 * how one of the two comes to disclose more than the other.
 *
 * EVERY string in the payload is offered, rather than a named list of
 * keys. The list was `path` / `preference` / `signal` / `artifact`, and a
 * census of the writers in this tree found artifact references in
 * `target`, `subject_a`, `subject_b`, `successor`, `predecessor`,
 * `source`, `source_path`, `note`, `file`, `files`, `retired`,
 * `superseded_by` and `conflicts` as well - so the list was not a
 * measurement of what a row discloses, it was a sample of it, and every
 * key outside it made its row unconditionally visible. Enumerating a
 * payload whose writers are open-ended is the defect, not the particular
 * keys that were missing from the enumeration.
 *
 * Offering too much is SAFE in a way offering too little is not: a string
 * that resolves to no artifact on disk is read as naming nothing and lets
 * its row through unchanged, which is the same answer the view gives an
 * absent key. So the fail direction of the widening is the harmless one.
 *
 * Array-valued keys are flattened rather than dropped.
 * {@link BrainLogEntryPayload} is `string | ReadonlyArray<string>` and
 * `parseLogDay` produces an array whenever a key repeats or uses the
 * indented sub-bullet form - so a `typeof === "string"` test answered
 * `undefined` for a real multi-artifact reference, which the view reads
 * as "names nothing".
 */
export function logEntryArtifactRefs(entry: BrainLogEntry): ReadonlyArray<string | undefined> {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const refs: Array<string | undefined> = [reconcileTopicPreferenceId(entry)];
  for (const value of Object.values(body)) {
    if (typeof value === "string") refs.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") refs.push(item);
    }
  }
  return refs;
}

/**
 * The preference a reconcile event is about, by id.
 *
 * A reconcile event names its subject by `topic`, not by id, and a
 * preference's slug is its topic: the open question on topic `x` is about
 * `pref-x`. A topic that cannot be a slug names no preference.
 */
export function reconcileTopicPreferenceId(entry: BrainLogEntry): string | undefined {
  if (entry.eventType !== BRAIN_LOG_EVENT_KIND.reconcile) return undefined;
  const topic = (entry.body ?? {})["topic"];
  return typeof topic === "string" && RECONCILE_TOPIC_SLUG_RE.test(topic)
    ? `${PREF_ID_PREFIX}${topic}`
    : undefined;
}
