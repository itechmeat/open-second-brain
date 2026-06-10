/**
 * CRUTCH(t_1459706f) - interim session-lineage inference.
 *
 * The deployed Hermes collapses `parent_session_id` into `session_id`
 * in its shell-hook payload (`_serialize_payload`) and exposes no
 * lineage field; upstream PR NousResearch/hermes-agent#42940 adds the
 * native field but has not merged. Until it ships, this module infers
 * the parent of a brand-new session id from the lineage ledger.
 *
 * The inference is deliberately conservative - a false stitch (two
 * unrelated conversations merged) is strictly worse than a missed
 * stitch (status quo). A link happens only when ALL hold:
 *
 *   1. the new session has NO ledger history of its own (a session
 *      seen before without a link is a parallel session);
 *   2. a predecessor exists in the SAME cwd;
 *   3. the predecessor's LATEST event evidences a compression
 *      boundary (PostCompact / PreCompact / SessionStart:compact);
 *   4. the predecessor's last activity falls within
 *      `CRUTCH_LINK_WINDOW_MS` before now.
 *
 * Time proximity alone NEVER links. Removal plan (kanban
 * t_1459706f): once the upstream PR merges and the deployed Hermes
 * emits `parent_session_id`, delete this file and every call site
 * carrying the CRUTCH(t_1459706f) marker; the native payload path in
 * `resolve.ts` already takes precedence.
 */

import {
  CRUTCH_LINK_WINDOW_MS,
  type LineageLedgerEntry,
  type LineageLedgerState,
} from "./ledger.ts";
import type { SessionLineage } from "./types.ts";

/**
 * Infer lineage for `sessionId` from the ledger, or return `null`
 * when no conservative link exists. CRUTCH(t_1459706f).
 */
export function resolveCrutchLineage(
  sessionId: string,
  cwd: string | undefined,
  ledger: LineageLedgerState,
  nowMs: number,
): SessionLineage | null {
  const own = ledger.get(sessionId);
  // A previously persisted link (from an earlier crutch or payload
  // resolution) is authoritative for the rest of the session.
  if (own?.lineage !== undefined && own.lineage.source !== "flat") {
    return own.lineage;
  }
  // Rule 1: known session without a link = parallel session, not a
  // continuation. Never re-guess.
  if (own !== undefined) return null;
  if (cwd === undefined || cwd.length === 0) return null;

  let predecessor: LineageLedgerEntry | null = null;
  for (const entry of ledger.values()) {
    if (entry.sessionId === sessionId) continue;
    if (entry.cwd !== cwd) continue; // Rule 2
    if (!entry.compressionEvidence) continue; // Rule 3
    const age = nowMs - entry.lastSeenMs;
    if (age < 0 || age > CRUTCH_LINK_WINDOW_MS) continue; // Rule 4
    if (predecessor === null || entry.lastSeenMs > predecessor.lastSeenMs) {
      predecessor = entry;
    }
  }
  if (predecessor === null) return null;

  const parentLineage = predecessor.lineage;
  return Object.freeze({
    rootId: parentLineage !== undefined ? parentLineage.rootId : predecessor.sessionId,
    parentId: predecessor.sessionId,
    depth: (parentLineage !== undefined ? parentLineage.depth : 0) + 1,
    source: "crutch" as const,
  });
}
