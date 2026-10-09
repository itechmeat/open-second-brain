/**
 * Per-device shard grammar for every append-only ledger in the vault.
 *
 * The vault is replicated with Syncthing. Two machines appending to the
 * same file inside one sync window produce a `.sync-conflict-*` copy that
 * no reader merges, so rows silently split across two files. `Brain/log/`
 * solved that in v0.10.8 by giving each device its own file and merging
 * every file at read; this module is that solution with the log-specific
 * parts removed, so the continuity store, the idempotency ledger, the
 * preference audit, the metrics sink and the session-lineage ledger share
 * ONE answer instead of five copies of it.
 *
 * The grammar is `<base>[.<shardId>].<ext>`:
 *
 *   - `<base>` is whatever the ledger already named its file after (a
 *     date, a month, a preference id, a metric surface, a fixed stem).
 *     Callers hand in the pattern, so a name outside their own layout is
 *     never mistaken for one of their shards;
 *   - `<shardId>` is the device id ({@link LEDGER_SHARD_ID_RE}, the same
 *     slug `resolveDeviceId` produces). ABSENT means the shard with the
 *     empty id - the legacy un-sharded file, which stays readable and
 *     never needs renaming;
 *   - `<ext>` is one of the extensions the ledger declares.
 *
 * Two rules hold everywhere:
 *
 *   - a `*.sync-conflict-*` copy is NEVER a shard, even when its middle
 *     segment happens to fit the shard-id shape. It is reported by the
 *     doctor and merged by hand;
 *   - a merged read is ordered by (ledger sort key, shard id, line), so
 *     every device sees the same sequence regardless of the order
 *     Syncthing delivered the files in.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDeviceId } from "../config.ts";
import { JSONL_LEDGER_EXT } from "./path-constants.ts";

/**
 * The shard-id shape: the lowercase slug `resolveDeviceId` produces,
 * bounded so a shard id can never dominate a file name. Kept in sync
 * with `DEVICE_ID_RE` in `src/core/config.ts` by construction - the only
 * values that ever reach a shard name come from that resolver - and
 * deliberately not shared with it: this one also has to admit the
 * segment as it appears MID-NAME, where the config regex's anchoring on
 * a leading alphanumeric is not what a reader of a file name checks.
 */
export const LEDGER_SHARD_ID_RE = /^[a-z0-9-]{1,32}$/;

/** Source form of {@link LEDGER_SHARD_ID_RE}, for composing name regexes. */
const SHARD_ID_PATTERN = "[a-z0-9-]{1,32}";

/**
 * A Syncthing conflict copy is named `<stem>.sync-conflict-<stamp>.<ext>`,
 * so its middle segment can pass the shard-id shape. Named once because
 * both the recogniser that must REJECT it and the leftover reporter that
 * must FIND it key on the same marker.
 */
export const SYNC_CONFLICT_SHARD_PREFIX = "sync-conflict";

/** The marker as it appears inside a file name, dot included. */
const SYNC_CONFLICT_MARKER = `.${SYNC_CONFLICT_SHARD_PREFIX}-`;

/**
 * One ledger's file-name layout: the base-name pattern (regex SOURCE,
 * anchored here) and the extensions it writes.
 *
 * The base is a pattern rather than a literal because most ledgers name
 * their files after a shape (`\d{4}-\d{2}` for a month) rather than a
 * fixed string. A ledger whose base is a caller-supplied value passes it
 * through {@link literalBase} instead, which is what keeps a preference
 * id containing a dot from being read as `<base>.<shardId>`.
 */
export interface LedgerShardGrammar {
  /** Regex source matching the base name, WITHOUT anchors. */
  readonly base: string;
  /** Extensions, without the leading dot. */
  readonly extensions: ReadonlyArray<string>;
}

/**
 * The extension every JSON Lines ledger writes, without the leading dot.
 * Declared in the leaf `path-constants.ts` (see its docblock for the import
 * cycle that motivated the move) and re-exported here so every ledger keeps
 * importing it from this module.
 */
export { JSONL_LEDGER_EXT };

/**
 * The grammar of a JSON Lines ledger whose base is one fixed file stem
 * (`<stem>[.<shardId>].jsonl`). The stem is escaped through
 * {@link literalBase}, so the writer can hand the same stem to
 * {@link shardedFileName} and the two can never disagree on the name.
 */
export function jsonlLedgerGrammar(stem: string): LedgerShardGrammar {
  return Object.freeze({
    base: literalBase(stem),
    extensions: Object.freeze([JSONL_LEDGER_EXT]),
  });
}

/** The shape of one recognised ledger file name. */
export interface ParsedShardedName {
  readonly base: string;
  /** Empty string for the legacy un-sharded file. */
  readonly shardId: string;
  readonly ext: string;
}

/** A parsed name together with where it was found. */
export interface ShardedFile extends ParsedShardedName {
  readonly path: string;
  readonly name: string;
}

/**
 * Escape `value` so it matches itself and nothing else inside a grammar
 * base. The dot is the character that matters: a preference id is only
 * bounded by {@link import('./paths.ts').validateSlug}, which permits
 * one, and an unescaped `pref-a.b` would let `pref-a.b.jsonl` parse as
 * the `b` shard of `pref-a`.
 */
export function literalBase(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiled name regexes, keyed by grammar. Every listing call parses one
 * name per directory entry, so compiling the pattern per call would make
 * a directory scan quadratic in the regex engine rather than in the
 * files. The key is the grammar's full content, so two grammars that
 * differ anywhere never share a pattern.
 */
const NAME_RE_CACHE = new Map<string, RegExp>();

function nameRe(grammar: LedgerShardGrammar): RegExp {
  // JSON rather than a joined string: it needs no separator character,
  // so two grammars whose parts differ can never collide by having those
  // parts run together.
  const key = JSON.stringify([grammar.base, grammar.extensions]);
  const cached = NAME_RE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const exts = grammar.extensions.map(literalBase).join("|");
  const re = new RegExp(`^(${grammar.base})(?:\\.(${SHARD_ID_PATTERN}))?\\.(${exts})$`);
  NAME_RE_CACHE.set(key, re);
  return re;
}

/**
 * Decide whether `name` is a file of the ledger `grammar` describes, and
 * which shard of it.
 *
 * Returns `null` for anything else, INCLUDING a hand-renamed Syncthing
 * conflict copy whose middle segment fits the shard-id shape.
 */
export function parseShardedName(
  name: string,
  grammar: LedgerShardGrammar,
): ParsedShardedName | null {
  const m = nameRe(grammar).exec(name);
  if (m === null) return null;
  const shardId = m[2] ?? "";
  if (shardId.startsWith(SYNC_CONFLICT_SHARD_PREFIX)) return null;
  return { base: m[1]!, shardId, ext: m[3]! };
}

/**
 * The file name a writer on shard `shardId` appends to. The empty shard
 * id yields the bare `<base>.<ext>`, which is exactly the legacy name -
 * so a vault whose device id resolves empty writes the same bytes to the
 * same file it always did, and no migration renames anything.
 */
export function shardedFileName(base: string, shardId: string, ext: string): string {
  if (shardId !== "" && !LEDGER_SHARD_ID_RE.test(shardId)) {
    throw new Error(
      `invalid ledger shard id ${JSON.stringify(shardId)} - ` +
        "expected a lowercase slug matching the device_id config shape",
    );
  }
  return shardId === "" ? `${base}.${ext}` : `${base}.${shardId}.${ext}`;
}

/** True for a name Syncthing wrote as a conflict copy. */
export function isSyncConflictName(name: string): boolean {
  return name.includes(SYNC_CONFLICT_MARKER);
}

/**
 * Every file under `dir` that `grammar` recognises, sorted by name.
 *
 * An absent directory lists nothing. A directory that exists but cannot
 * be READ throws: the callers that must distinguish "no shards" from
 * "not looked at" (the doctor's conflict sweep) rely on the throw, and
 * absorbing it here would hand them the one answer they cannot act on.
 */
export function listShardedFiles(dir: string, grammar: LedgerShardGrammar): ShardedFile[] {
  if (!existsSync(dir)) return [];
  const out: ShardedFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    const parsed = parseShardedName(entry.name, grammar);
    if (parsed === null) continue;
    out.push({ ...parsed, path: join(dir, entry.name), name: entry.name });
  }
  return out;
}

/**
 * `*.sync-conflict-*` copies left behind by Syncthing under `dir`. The
 * shard layout prevents NEW conflicts; doctor surfaces any leftovers for
 * a manual union+dedup merge. Absent directory: none. Unreadable
 * directory: throws, for the reason {@link listShardedFiles} gives.
 */
export function listSyncConflictFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isSyncConflictName(e.name))
    .map((e) => join(dir, e.name))
    .toSorted();
}

/** One shard's rows, in the order the shard itself holds them. */
export interface ShardRows<T> {
  /** Empty string for the legacy un-sharded file. */
  readonly shardId: string;
  readonly rows: ReadonlyArray<T>;
}

/**
 * Every non-blank line of every shard of one ledger, grouped by shard:
 * shards in ascending name order, lines in append order.
 *
 * A shard listed but vanished before the read is skipped (a concurrent
 * compactor won); any other read failure propagates - "could not tell"
 * must never resolve to "no rows". Conflict copies are never listed.
 */
export function readShardLinesByShard(
  dir: string,
  grammar: LedgerShardGrammar,
): Array<ShardRows<string>> {
  const out: Array<ShardRows<string>> = [];
  for (const shard of listShardedFiles(dir, grammar)) {
    let text: string;
    try {
      text = readFileSync(shard.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    out.push({
      shardId: shard.shardId,
      rows: text.split("\n").filter((line) => line.trim() !== ""),
    });
  }
  return out;
}

/**
 * Every non-blank line of every shard of one ledger, shards in ascending
 * name order (the legacy name sorts among the device shards by the shared
 * stem) and lines in append order.
 *
 * This is the merged read for ledgers whose rows carry no sort key of their
 * own: a single-shard vault reads back in exactly the order it always did,
 * and a multi-device one gets the deterministic shard-id order instead of
 * Syncthing's arrival order. Failure handling is
 * {@link readShardLinesByShard}'s.
 */
export function readShardedLines(dir: string, grammar: LedgerShardGrammar): string[] {
  return readShardLinesByShard(dir, grammar).flatMap((shard) => shard.rows);
}

/**
 * Interleave shards into one ascending sequence by each row's time `at`,
 * WITHOUT ever reordering the rows of one shard.
 *
 * This is the merge for a ledger whose own file order is authoritative -
 * an append-only journal read newest-first, where a clock stepped back on
 * one device must not reshuffle that device's history. Each step takes the
 * earliest head among the shards; equal heads go to the lower shard id, so
 * every device sees the same sequence. A single shard reads back in
 * exactly its file order. `at` must return a comparable number for every
 * row (map an unreadable time to a fixed sentinel, not NaN).
 */
export function interleaveShardRows<T>(
  shards: ReadonlyArray<ShardRows<T>>,
  at: (value: T) => number,
): T[] {
  const cursors = shards.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let pick = -1;
    let pickAt = 0;
    for (const [index, shard] of shards.entries()) {
      const head = shard.rows[cursors[index]!];
      if (head === undefined) continue;
      const time = at(head);
      const earlier =
        pick === -1 || time < pickAt || (time === pickAt && shard.shardId < shards[pick]!.shardId);
      if (earlier) {
        pick = index;
        pickAt = time;
      }
    }
    if (pick === -1) return out;
    out.push(shards[pick]!.rows[cursors[pick]!]!);
    cursors[pick] = cursors[pick]! + 1;
  }
}

/** One row read out of one shard, tagged with where it came from. */
export interface ShardedRow<T> {
  readonly value: T;
  readonly shardId: string;
  /** 0-based position within its own shard. */
  readonly line: number;
}

/**
 * Merge rows drawn from several shards into the one order every device
 * agrees on: the ledger's own sort key first, then the shard id, then
 * either the ledger's own last-resort key or the line's position inside
 * its shard.
 *
 * The shard id is the tie-break rather than the arrival order because
 * arrival order is precisely what differs between two Syncthing peers.
 *
 * `withinShard` is for a ledger whose rows carry an identity of their own
 * that is independent of which device wrote them - the continuity
 * record's content-hash id, say. Supplying it keeps a single-shard vault
 * reading back in exactly the order it did before sharding existed;
 * omitting it falls back to append order, which is the only ordering the
 * file itself asserts.
 */
export function mergeShardedRows<T>(
  rows: ReadonlyArray<ShardedRow<T>>,
  sortKey: (value: T) => string,
  withinShard?: (value: T) => string,
): T[] {
  return rows
    .map((row) => ({ row, key: sortKey(row.value) }))
    .toSorted((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      if (a.row.shardId !== b.row.shardId) return a.row.shardId < b.row.shardId ? -1 : 1;
      if (withinShard === undefined) return a.row.line - b.row.line;
      const left = withinShard(a.row.value);
      const right = withinShard(b.row.value);
      return left === right ? a.row.line - b.row.line : left < right ? -1 : 1;
    })
    .map((entry) => entry.row.value);
}

/**
 * The shard id THIS device appends under.
 *
 * Defaults to `resolveDeviceId()` from the device-local config; the empty
 * string selects the legacy un-sharded file.
 *
 * ANY resolution failure falls back to the legacy file - a missing HOME,
 * an unwritable config home, or a config file that is present but cannot
 * be read (`ConfigReadError`). The append paths are the ones that absorb
 * that error, and it is deliberate rather than an oversight: appending is
 * the always-on write path behind every hook and every session-capture
 * event, so failing it turns one bad file mode into a dead session. The
 * fallback is also not a neutral value invented to look healthy - it is
 * the documented shard shape the `O2B_DEVICE_ID=""` opt-out selects, it
 * loses no data, and the per-file lock still orders concurrent writers.
 * The condition itself is not swallowed anywhere: every OTHER caller of
 * `resolveDeviceId` propagates it, and the CLI reports it by name.
 */
export function resolveAppendShardId(): string {
  try {
    return resolveDeviceId();
  } catch {
    // Legacy un-sharded file. See the docblock above for why the append
    // paths absorb what every other caller propagates.
    return "";
  }
}
