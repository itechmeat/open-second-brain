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
 * exists. Lines written before the chain existed are counted as legacy
 * rather than reported - a ledger predating this release is not
 * corrupt.
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
  lineageChainHash,
  readLineageGaps,
  readLineageLedgerLines,
  sessionLineageLedgerPath,
} from "./ledger.ts";

/** Site recorded on every notice this module emits. */
const VERIFY_SITE = "brain.lineage.verify";

export interface LineageLedgerVerification {
  /** The ledger that was verified, whether or not it exists. */
  readonly path: string;
  /** Parseable lines found. */
  readonly lines: number;
  /** Lines carrying a sequence number and a chain hash. */
  readonly chained: number;
  /** Lines written before the chain existed. Not a finding. */
  readonly legacy: number;
  /** Observations recorded as never-appended gaps. */
  readonly droppedObservations: number;
  /** Every finding, in file order. Empty on a clean ledger. */
  readonly notices: ReadonlyArray<DegradationNotice>;
  /** True when nothing was found. */
  readonly ok: boolean;
}

/**
 * Verify the ledger's sequence and hash chain and collect recorded
 * gaps. Never throws: an unreadable or unparseable ledger reports what
 * it could read, because a verifier that fails on the file it exists to
 * inspect reproduces the silent failure it is meant to remove.
 */
export function verifyLineageLedger(vault: string): LineageLedgerVerification {
  const notices: DegradationNotice[] = [];
  let lines = 0;
  let chained = 0;
  let legacy = 0;

  const entries = readLineageLedgerLines(vault);
  lines = entries.length;
  let previous: LedgerLine | undefined;
  for (const entry of entries) {
    const line = entry.line;
    if (!isChainedLine(line)) {
      legacy++;
      // A legacy line breaks the adjacency the checks below rely on;
      // the next chained line becomes a fresh anchor.
      previous = undefined;
      continue;
    }
    chained++;
    checkChainedLine(line, previous, notices);
    previous = line;
  }

  const gaps = readLineageGaps(vault);
  for (const gap of gaps) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageObservationDropped,
      site: VERIFY_SITE,
      detail:
        `observation for session ${gap.sessionId} (event ${gap.event}) ` +
        `was never appended: ${gap.reason}`,
    });
  }

  return Object.freeze({
    path: safeLedgerPath(vault),
    lines,
    chained,
    legacy,
    droppedObservations: gaps.length,
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
): void {
  const seq = line.seq!;
  if (lineageChainHash(line) !== line.h) {
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.lineageChainBroken,
      site: VERIFY_SITE,
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
