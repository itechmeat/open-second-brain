/**
 * Brain log chain verification (who-wrote-what, Task E).
 *
 * Every note write, every freeze and every refusal is now recorded as a
 * Brain log event, which makes the log the attribution record for the
 * vault. A record only carries weight if a line someone deleted or
 * edited is DETECTABLE, so every JSONL row appended from this release on
 * carries `prev` and `h` ({@link LOG_CHAIN_FIELDS}) and this module is
 * the pass that walks them.
 *
 * ## One chain per shard, and only per shard
 *
 * The log is sharded per device and per day, and two machines append to
 * two files that Syncthing later delivers in whatever order it likes.
 * There is therefore no total order to chain across, and pretending
 * otherwise would report every peer's normal history as a break. The
 * chain's unit is one FILE: a break in one device's shard says nothing
 * about another's, and every count here is that shard's alone.
 *
 * The markdown twin is not chained. It is a derived rendering of the
 * same events for human eyes in Obsidian, it is meant to be readable and
 * therefore editable, and the JSONL sidecar is the machine-primary
 * surface every reader already prefers.
 *
 * ## Report-only, exactly like the lineage ledger's chain
 *
 * Nothing in the read path consults this. `readLogDay` returns every
 * event it can parse whether the shard links up or not, because a log
 * that refused to be read because someone edited it would be a worse
 * outcome than the edit. What the chain buys is that the edit has a
 * name, a file and a line number.
 *
 * ## What counts as a break, and what does not
 *
 * A line with no `h` is LEGACY: written before the chain shipped, or by
 * a peer still on an older build. Legacy lines are counted and never
 * reported - but only while they precede the chain. The first chained
 * line in a shard anchors it with `prev: null`, and once a shard has a
 * chained line, a line without one is not history: it is a line whose
 * links were stripped, so it is reported as `malformed` at its own line.
 * That asymmetry is the whole reason a stripped middle line cannot pass.
 *
 * The head of a shard is NOT exempt. `lineage/verify.ts` exempts its
 * first line because that ledger compacts and its head legitimately
 * names a predecessor that no longer exists; the Brain log never
 * compacts, so a first chained line carrying a non-null `prev` means the
 * head of the file was cut off - and reporting that is the point.
 *
 * Three break reasons, first one per shard reported ({@link
 * LOG_CHAIN_BREAK_REASON}). The walk continues past a break so the
 * counts describe the whole file rather than its head.
 */

import {
  DEGRADATION_CODE,
  type DegradationNotice,
  emitDegradationNotice,
} from "../integrity/degradation.ts";
import { LOG_CHAIN_FIELDS, logChainHash } from "./log.ts";
import { listLogShardFiles, scanJsonlRows, type LogShardFile } from "./log-jsonl.ts";
import { brainDirs } from "./paths.ts";

export { LOG_CHAIN_FIELDS, logChainHash } from "./log.ts";

/** Site recorded on every notice this module emits. */
const VERIFY_SITE = "brain.log.chain.verify";

/**
 * Broken shards listed individually before the rest are folded into one
 * counted notice.
 *
 * A vault that has been running for a year holds hundreds of shards, and
 * a bulk edit (a botched merge of a conflict copy, say) can break most
 * of them at once. Pouring all of those into the doctor's report buries
 * every other finding beside them. The remainder is never dropped: it is
 * reported as an explicit count, so a capped listing is never mistaken
 * for the whole finding. Same bound and same reasoning as
 * `MAX_ITEMIZED_FINDINGS` in `lineage/verify.ts`.
 */
const MAX_ITEMIZED_SHARDS = 20;

/** Only the machine-primary sidecar is chained; the markdown twin is derived. */
const CHAINED_EXTENSION = "jsonl";

/** Why one shard's chain does not hold. */
export const LOG_CHAIN_BREAK_REASON = Object.freeze({
  /** The line's recorded `h` is not what its content hashes to: it was edited. */
  hashMismatch: "hash-mismatch",
  /** The line's `prev` is not the preceding chained line's `h`: a line was removed or reordered. */
  prevMismatch: "prev-mismatch",
  /** The line is not a chainable row where the chain had already started. */
  malformed: "malformed",
} as const);

export type LogChainBreakReason =
  (typeof LOG_CHAIN_BREAK_REASON)[keyof typeof LOG_CHAIN_BREAK_REASON];

/** Where a shard's chain stops holding, and why. */
export interface LogChainBreak {
  /** 1-based line number inside the shard file - the number an editor shows. */
  readonly line: number;
  readonly reason: LogChainBreakReason;
}

/** One shard's verdict. */
export interface LogChainShardVerification {
  /** The shard file that was verified. */
  readonly path: string;
  /** The UTC day this shard records. */
  readonly date: string;
  /** Empty string for the legacy un-sharded pair. */
  readonly shardId: string;
  /** Lines of this shard carrying a chain hash. */
  readonly chained: number;
  /**
   * Lines of this shard carrying no chain hash. Legitimate history when
   * they precede the chain; one appearing after it is also reported as
   * {@link LOG_CHAIN_BREAK_REASON.malformed}.
   */
  readonly legacy: number;
  /**
   * Lines that are neither: not JSON, not an object, or a chained row
   * whose own projection cannot be hashed. Reported, never silently
   * counted as clean.
   */
  readonly unparsed: number;
  /** The first place the chain stops holding, or `null` on a clean shard. */
  readonly firstBreak: LogChainBreak | null;
}

export interface LogChainVerification {
  /** Per-shard verdicts, in file-name order. Empty when the log holds no shard. */
  readonly shards: ReadonlyArray<LogChainShardVerification>;
  /** Every finding. Empty on a clean log. */
  readonly notices: ReadonlyArray<DegradationNotice>;
  /** True when nothing was found. */
  readonly ok: boolean;
}

/**
 * Walk every JSONL shard of the Brain log and report where each one
 * stops linking up.
 *
 * Never throws. A log directory that cannot be listed, and a shard whose
 * bytes cannot be read, are both findings rather than silence - "not
 * verified" is not "verified clean", and the caller here is the doctor,
 * which must not report a store it could not open as healthy.
 *
 * Syncthing conflict copies are excluded, because they are not shards:
 * the shard recogniser rejects them by name and the doctor reports them
 * under its own `sync-conflict-log` finding. Verifying them here would
 * report one condition twice, and the copy's rows were split off from a
 * shard rather than appended to it, so its chain never held by
 * construction.
 */
export function verifyLogChain(vault: string): LogChainVerification {
  const notices: DegradationNotice[] = [];
  let files: ReadonlyArray<LogShardFile>;
  try {
    files = listLogShardFiles(vault);
  } catch (err) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.logChainBroken,
      site: VERIFY_SITE,
      path: safeLogDir(vault),
      detail:
        "the Brain log directory could not be listed, so no shard in it was verified: " +
        `${(err as NodeJS.ErrnoException).message ?? String(err)}`,
    });
    return Object.freeze({ shards: Object.freeze([]), notices: Object.freeze(notices), ok: false });
  }

  const shards = files
    .filter((file) => file.ext === CHAINED_EXTENSION)
    .map((file) => verifyShard(file, notices));

  let reported = 0;
  let unreported = 0;
  for (const shard of shards) {
    if (shard.firstBreak === null) continue;
    if (reported >= MAX_ITEMIZED_SHARDS) {
      unreported++;
      continue;
    }
    reported++;
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.logChainBroken,
      site: VERIFY_SITE,
      path: shard.path,
      detail: `line ${shard.firstBreak.line} ${breakDetail(shard.firstBreak.reason)}`,
    });
  }
  if (unreported > 0) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.logChainBroken,
      site: VERIFY_SITE,
      path: safeLogDir(vault),
      detail:
        `${unreported} further log shards do not link up and are not itemized ` +
        `(${reported + unreported} broken of ${shards.length} verified)`,
    });
  }

  return Object.freeze({
    shards: Object.freeze(shards),
    notices: Object.freeze(notices),
    ok: notices.length === 0,
  });
}

/** English for one break reason, for the notice and the CLI alike. */
export function breakDetail(reason: LogChainBreakReason): string {
  switch (reason) {
    case LOG_CHAIN_BREAK_REASON.hashMismatch:
      return "carries a hash its content does not match - the line was edited after it was written";
    case LOG_CHAIN_BREAK_REASON.prevMismatch:
      return "does not link to the line before it - a line between them was removed or reordered";
    case LOG_CHAIN_BREAK_REASON.malformed:
      return (
        "is not a chainable row where the chain had already started - its links were stripped, " +
        "and the next line's is no longer checkable"
      );
  }
}

/**
 * Verify one shard's chain, in file order.
 *
 * At most one break is RECORDED per shard - the first - but the walk
 * runs to the end so `chained`, `legacy` and `unparsed` describe the
 * whole file. An operator deciding whether a shard is worth recovering
 * needs both halves: where it broke, and how much of it is intact.
 */
function verifyShard(file: LogShardFile, notices: DegradationNotice[]): LogChainShardVerification {
  const scan = scanJsonlRows(file.path);
  if (!scan.readable) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.logChainBroken,
      site: VERIFY_SITE,
      path: file.path,
      detail:
        `the shard exists but could not be read (${scan.failure ?? "no reason reported"}), ` +
        "so no line in it was verified - an unverifiable history is not a clean one",
    });
  }

  let chained = 0;
  let legacy = 0;
  let unparsed = 0;
  let firstBreak: LogChainBreak | null = null;
  /**
   * What the next chained line's `prev` must be: the previous chained
   * line's `h`, `null` at genesis, or `undefined` when the line before
   * it was already reported and its successor's link is unknowable.
   *
   * `null` rather than `undefined` at the START of the shard is the
   * difference between this chain and the lineage ledger's. That ledger
   * compacts, so its first line legitimately names a predecessor that no
   * longer exists and its head is exempt. The Brain log never compacts -
   * a shard begins at its genesis line - so a first chained line naming a
   * predecessor means the head of the file was cut off, which is exactly
   * the tampering worth catching.
   */
  let previous: string | null | undefined = null;
  let sawChained = false;

  const breakAt = (line: number, reason: LogChainBreakReason): void => {
    if (firstBreak === null) firstBreak = { line, reason };
  };

  for (const entry of scan.lines) {
    const row = entry.row;
    if (row === null) {
      unparsed++;
      breakAt(entry.lineNumber, LOG_CHAIN_BREAK_REASON.malformed);
      // A line the parser cannot read breaks the adjacency the `prev`
      // check relies on; the next chained line's link is unknowable
      // rather than wrong, so it is not reported a second time.
      previous = undefined;
      continue;
    }

    const h = row[LOG_CHAIN_FIELDS.h];
    if (typeof h !== "string" || h === "") {
      legacy++;
      // Legitimate history at the HEAD of a shard, a stripped line
      // anywhere after it. See this module's docblock.
      if (sawChained) breakAt(entry.lineNumber, LOG_CHAIN_BREAK_REASON.malformed);
      previous = undefined;
      continue;
    }

    const projection = chainableProjection(row);
    if (projection === null) {
      unparsed++;
      breakAt(entry.lineNumber, LOG_CHAIN_BREAK_REASON.malformed);
      previous = undefined;
      continue;
    }

    chained++;
    sawChained = true;
    const recomputed = logChainHash(
      projection.prev,
      projection.ts,
      projection.kind,
      projection.payload,
    );
    if (recomputed !== h) {
      // At most ONE finding per line: a tampered line would otherwise
      // also fail its successor's `prev` check and report the same
      // damage twice. `previous` still takes the stored hash, which is
      // what the next line actually links to.
      breakAt(entry.lineNumber, LOG_CHAIN_BREAK_REASON.hashMismatch);
    } else if (previous !== undefined && projection.prev !== previous) {
      breakAt(entry.lineNumber, LOG_CHAIN_BREAK_REASON.prevMismatch);
    }
    previous = h;
  }

  return Object.freeze({
    path: file.path,
    date: file.date,
    shardId: file.shardId,
    chained,
    legacy,
    unparsed,
    firstBreak,
  });
}

/** The four values a chain hash is computed over, or `null` when the row lacks them. */
interface ChainableProjection {
  readonly prev: string | null;
  readonly ts: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, string | ReadonlyArray<string>>>;
}

/**
 * Re-read a stored row as the exact value {@link logChainHash} was given
 * when the row was written, or `null` when it is not that shape.
 *
 * Strict on purpose: `prev` must be present and be a string or `null`,
 * and every payload value must be a string or an array of strings, which
 * is the whole of what `renderJsonlLine` can emit. A row outside that
 * shape cannot be rehashed, so reporting it as a hash MISMATCH would
 * name the wrong condition - it is malformed, and the caller says so.
 */
function chainableProjection(row: Readonly<Record<string, unknown>>): ChainableProjection | null {
  const prev = row[LOG_CHAIN_FIELDS.prev];
  if (prev !== null && typeof prev !== "string") return null;
  const ts = row["ts"];
  const kind = row["kind"];
  const payload = row["payload"];
  if (typeof ts !== "string" || typeof kind !== "string") return null;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const projected: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === "string") {
      projected[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      projected[key] = value as string[];
      continue;
    }
    return null;
  }
  return { prev, ts, kind, payload: projected };
}

/**
 * The log directory, or the vault root when the path builder refuses.
 * A notice must name SOMETHING an operator can look at, and a builder
 * that refuses has already been reported by its own caller.
 */
function safeLogDir(vault: string): string {
  try {
    return brainDirs(vault).log;
  } catch {
    return vault;
  }
}
