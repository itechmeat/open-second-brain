/**
 * Lineage ledger verification (context-integrity-gates, Unit D).
 *
 * The ledger is append-only JSONL whose read path is fail-soft BY
 * CONTRACT: `readLineageLedger` returns an empty map rather than
 * throwing, because both `resolveRootId` in the anticipatory cache and
 * the session-lifecycle hook depend on it never raising. That contract
 * is exactly why verification lives HERE and not there.
 *
 * This module REPORTS. It never refuses to start, never mutates the
 * ledger, and never changes what resolution returns - a ledger with a
 * broken chain still resolves lineage, and the break is surfaced as a
 * doctor finding instead of as an outage. Making the ledger a security
 * boundary is explicitly out of scope; the property being defended is
 * that an edited, truncated or never-written line is DETECTABLE, not
 * that it is impossible.
 *
 * Three conditions are checked over the chained lines, in file order:
 *
 *   - a line whose recomputed hash differs from its recorded one was
 *     edited after it was written;
 *   - a line whose `prev` does not match the preceding chained line's
 *     hash means a line between them was removed or reordered;
 *   - a sequence number that does not follow its predecessor's is the
 *     same condition seen from the other side.
 *
 * The FIRST chained line in the file is an anchor and is not checked
 * against a predecessor: compaction drops the head of the file by
 * design, so its `prev` legitimately names a line that no longer
 * exists.
 *
 * Three more conditions concern lines the chain checks never see, and
 * each of them used to verify as CLEAN:
 *
 *   - a non-blank line that is not a usable record. The reader drops it
 *     so that resolution survives; the verifier counts it, because a
 *     file of pure garbage reporting `ok: true` is the exact silent
 *     failure this wave exists to remove;
 *   - a ledger that exists but cannot be read. Nothing in it was
 *     verified, and "not verified" is not "verified clean";
 *   - a line with NO chain fields appearing after a chained one. Lines
 *     predating the chain are legitimate and sit at the head of the
 *     file, so they stay uncounted as findings - but the same shape in
 *     the middle is a line whose links were stripped, and because a
 *     legacy line resets the anchor it also silences the `prev` check on
 *     its successor. That is how a tampered middle line used to pass.
 *
 * Recorded gaps - observations the writer could not append, usually
 * because another process held the lock - are surfaced too. A gap is
 * the one failure the chain cannot show by itself: an observation that
 * never got a sequence number leaves no hole to find.
 */

import {
  DEGRADATION_CODE,
  type DegradationNotice,
  emitDegradationNotice,
} from "../../integrity/degradation.ts";
import {
  isChainedLine,
  type LedgerLine,
  type LineageLedgerScan,
  lineageChainHash,
  readLineageGapReport,
  scanLineageLedgerShards,
  sessionLineageLedgerPath,
} from "./ledger.ts";

/** Site recorded on every notice this module emits. */
const VERIFY_SITE = "brain.lineage.verify";

/**
 * Findings of one kind listed individually before the rest are folded
 * into a single counted notice.
 *
 * A destroyed ledger or a contention burst produces hundreds of
 * identical findings, and pouring all of them into the doctor's
 * `uncertain` stream buries every other diagnostic beside them. The
 * remainder is never dropped: it is reported as an explicit count, so a
 * capped listing is never mistaken for the whole finding.
 */
const MAX_ITEMIZED_FINDINGS = 20;

/**
 * One shard's verdict. The chain's unit is one FILE, so a break in one
 * device's shard says nothing about another's and every count here is
 * that shard's alone.
 */
export interface LineageLedgerShardVerification {
  /** Empty string for the legacy un-sharded ledger. */
  readonly shardId: string;
  /** The shard that was verified. */
  readonly path: string;
  /** The shard file is on disk. */
  readonly exists: boolean;
  /** The file's bytes were obtained. False for an unreadable shard. */
  readonly readable: boolean;
  /** Parseable lines found in this shard. */
  readonly lines: number;
  /** Non-blank lines of this shard that could not be read as a record. */
  readonly skipped: number;
  /** Lines of this shard carrying a sequence number and a chain hash. */
  readonly chained: number;
  /** Lines of this shard carrying no chain fields. */
  readonly legacy: number;
  /** This shard's findings, in file order. */
  readonly notices: ReadonlyArray<DegradationNotice>;
  /** True when this shard produced no finding. */
  readonly ok: boolean;
}

export interface LineageLedgerVerification {
  /**
   * The ledger this device would append to, whether or not it exists.
   * {@link shards} names every ledger that WAS verified.
   */
  readonly path: string;
  /** At least one ledger shard is on disk. Distinguishes "no ledger" from "empty ledger". */
  readonly exists: boolean;
  /** Every shard on disk had its bytes obtained. False when one could not be read. */
  readonly readable: boolean;
  /** Parseable lines found, across every shard. */
  readonly lines: number;
  /** Non-blank lines that could not be read as a record. Each is a finding. */
  readonly skipped: number;
  /** Lines carrying a sequence number and a chain hash. */
  readonly chained: number;
  /** Lines carrying no chain fields. A finding only AFTER a chained line. */
  readonly legacy: number;
  /** Per-shard verdicts, in shard-id order. Empty when no shard exists. */
  readonly shards: ReadonlyArray<LineageLedgerShardVerification>;
  /** Observations recorded as never-appended gaps, listed plus discarded. */
  readonly droppedObservations: number;
  /** True when the gap sidecar's bound discarded records it can no longer list. */
  readonly gapsTruncated: boolean;
  /** Every finding, shard by shard then in file order. Empty on a clean ledger. */
  readonly notices: ReadonlyArray<DegradationNotice>;
  /** True when nothing was found. */
  readonly ok: boolean;
}

export interface VerifyLineageLedgerOptions {
  /** Injected clock (epoch ms) for the gap retention window. */
  readonly nowMs?: number;
}

/**
 * Verify the ledger's sequence and hash chain and collect recorded
 * gaps. Never throws: an unreadable or unparseable ledger reports what
 * it could read, because a verifier that fails on the file it exists to
 * inspect reproduces the silent failure it is meant to remove.
 *
 * It does not, however, report such a ledger as CLEAN. `ok` used to be
 * true for a file of pure garbage, for a wholly truncated one, and for
 * one the process could not open, because the reader dropped every
 * unusable line before the verifier could count it. Those three are now
 * findings; the read path that resolution depends on is unchanged.
 */
export function verifyLineageLedger(
  vault: string,
  opts: VerifyLineageLedgerOptions = {},
): LineageLedgerVerification {
  const notices: DegradationNotice[] = [];
  const path = safeLedgerPath(vault);

  // One shard, one chain. Every shard is verified in full and reports
  // under its OWN path, so an operator holding a finding knows which
  // machine's ledger to look at.
  const shards: LineageLedgerShardVerification[] = [];
  for (const scan of scanLineageLedgerShards(vault)) {
    shards.push(verifyShard(scan.shardId, scan.path, scan));
  }
  for (const shard of shards) notices.push(...shard.notices);

  const lines = shards.reduce((sum, shard) => sum + shard.lines, 0);
  const skippedTotal = shards.reduce((sum, shard) => sum + shard.skipped, 0);
  const chained = shards.reduce((sum, shard) => sum + shard.chained, 0);
  const legacy = shards.reduce((sum, shard) => sum + shard.legacy, 0);

  const gaps = readLineageGapReport(vault, opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {});
  for (const gap of gaps.records.slice(0, MAX_ITEMIZED_FINDINGS)) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageObservationDropped,
      site: VERIFY_SITE,
      detail:
        `observation for session ${gap.sessionId} (event ${gap.event}) ` +
        `was never appended: ${gap.reason}`,
    });
  }
  const unlisted = gaps.total - Math.min(gaps.records.length, MAX_ITEMIZED_FINDINGS);
  if (unlisted > 0) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageObservationDropped,
      site: VERIFY_SITE,
      detail:
        `${unlisted} further observations were never appended and are not itemized` +
        (gaps.truncated ? ` (${gaps.discarded} beyond the sidecar's retained records)` : ""),
    });
  }

  return Object.freeze({
    path,
    exists: shards.some((shard) => shard.exists),
    readable: shards.length > 0 && shards.every((shard) => shard.readable),
    lines,
    skipped: skippedTotal,
    chained,
    legacy,
    shards: Object.freeze(shards),
    droppedObservations: gaps.total,
    gapsTruncated: gaps.truncated,
    notices: Object.freeze(notices),
    ok: notices.length === 0,
  });
}

/**
 * Verify one shard's chain. Extracted from the whole-ledger pass with no
 * change to what it checks: the conditions in this module's docblock all
 * concern lines that are ADJACENT IN ONE FILE, and a shard is exactly
 * that file.
 */
function verifyShard(
  shardId: string,
  path: string,
  scan: LineageLedgerScan,
): LineageLedgerShardVerification {
  const notices: DegradationNotice[] = [];
  let chained = 0;
  let legacy = 0;

  if (scan.exists && !scan.readable) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
      path,
      detail:
        "the ledger exists but could not be read, so no line in it was verified - " +
        "an unverifiable history is not a clean one",
    });
  }
  const skipped = scan.skippedLineNumbers;
  for (const lineNumber of skipped.slice(0, MAX_ITEMIZED_FINDINGS)) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
      path,
      detail:
        `line ${lineNumber} could not be read as a ledger record; the observation it ` +
        "carried is lost, which is not the same as never having been made",
    });
  }
  if (skipped.length > MAX_ITEMIZED_FINDINGS) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
      path,
      detail:
        `${skipped.length - MAX_ITEMIZED_FINDINGS} further lines could not be read as a ` +
        `ledger record and are not itemized (${skipped.length} of ` +
        `${skipped.length + scan.lines.length} non-blank lines in total)`,
    });
  }

  let previous: LedgerLine | undefined;
  let sawChained = false;
  let legacyReported = 0;
  for (const entry of scan.lines) {
    const line = entry.line;
    if (!isChainedLine(line)) {
      legacy++;
      // Lines predating the chain are legitimate and sit at the HEAD of
      // the file. One appearing after a chained line is not history: it
      // is a line whose chain fields were removed, and because it resets
      // the anchor below it also leaves its successor's `prev`
      // unchecked - which is how a tampered middle line used to pass.
      if (sawChained && legacyReported < MAX_ITEMIZED_FINDINGS) {
        legacyReported++;
        emitDegradationNotice(notices, {
          code: DEGRADATION_CODE.lineageChainBroken,
          site: VERIFY_SITE,
          path,
          detail:
            `session ${line.sid} at ${line.at}: a line with no chain fields follows a chained ` +
            "one - its links were stripped, and the next line's is no longer checkable",
        });
      }
      // A legacy line breaks the adjacency the checks below rely on;
      // the next chained line becomes a fresh anchor.
      previous = undefined;
      continue;
    }
    chained++;
    sawChained = true;
    checkChainedLine(line, previous, notices, path);
    previous = line;
  }

  return Object.freeze({
    shardId,
    path,
    exists: scan.exists,
    readable: scan.readable,
    lines: scan.lines.length,
    skipped: skipped.length,
    chained,
    legacy,
    notices: Object.freeze(notices),
    ok: notices.length === 0,
  });
}

/**
 * Check one chained line. At most ONE finding per line: a tampered line
 * would otherwise also fail its successor's `prev` check and report the
 * same damage twice.
 */
function checkChainedLine(
  line: LedgerLine,
  previous: LedgerLine | undefined,
  notices: DegradationNotice[],
  path: string,
): void {
  const seq = line.seq!;
  if (lineageChainHash(line) !== line.h) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
      path,
      detail:
        `sequence ${seq} (session ${line.sid}): content does not match its ` +
        "recorded hash - the line was edited after it was written",
    });
    return;
  }
  if (previous === undefined) return; // chain anchor
  if ((line.prev ?? null) !== previous.h) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
      path,
      detail:
        `sequence ${seq} (session ${line.sid}): does not link to sequence ` +
        `${previous.seq} - a line between them was removed or reordered`,
    });
    return;
  }
  if (seq !== previous.seq! + 1) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
      path,
      detail: `sequence ${seq} (session ${line.sid}): follows sequence ${previous.seq}`,
    });
  }
}

function safeLedgerPath(vault: string): string {
  try {
    return sessionLineageLedgerPath(vault);
  } catch {
    return vault;
  }
}
