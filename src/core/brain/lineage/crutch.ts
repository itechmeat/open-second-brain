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
 *   1. the new session has NO history of its own - neither a ledger
 *      line NOR a recorded gap (a session seen before without a link is
 *      a parallel session, and a dropped observation is still a session
 *      that spoke);
 *   2. a predecessor exists in the SAME cwd, and no other session has
 *      already continued from it;
 *   3. that predecessor's git working state - repo, branch, commit -
 *      matches this session's, and both sides attested one;
 *   4. the predecessor's LATEST event evidences a compression
 *      boundary (PostCompact / PreCompact / SessionStart:compact);
 *   5. the predecessor's last activity falls within
 *      `CRUTCH_LINK_WINDOW_MS` before now;
 *   6. EXACTLY ONE predecessor survives 2-5.
 *
 * Time proximity alone NEVER links.
 *
 * ## Fail-closed (context-integrity-gates, Unit C)
 *
 * Rule 6 is the correction that matters most. This resolver used to
 * break a multi-candidate tie by taking the largest `lastSeenMs`, so
 * two concurrent sessions in one directory - both inside the window,
 * both showing compression evidence - silently stitched to whichever
 * had spoken more recently. A wrong-but-plausible resume injects
 * another branch's continuity as fact, and downstream the anticipatory
 * cache path derives from the lineage root, so a mis-stitch redirects
 * one conversation's cache into another's file. Ambiguity now ABSTAINS.
 *
 * Rule 3 is the second: `cwd` is a string, and one string names many
 * working states. The same directory on a different branch, or after a
 * commit, is a different context, and a session resumed across that
 * boundary is not the same work. Identity that only ONE side attested
 * is refused too - an unverifiable claim is not evidence.
 *
 * Every refusal is NAMED. The old signature returned a bare `null` into
 * which four distinct causes collapsed - no candidate, self already
 * known, no cwd, several candidates - leaving every caller unable to
 * tell a genuine absence of history from a mechanism that declined. The
 * abstention is a returned value, never a throw: this path is fail-soft
 * by contract and must not raise into a lifecycle hook.
 *
 * The 900-second window stays as the freshness bound. Replacing the
 * timing crutch with durable work identity is a separate architectural
 * unit (kanban t_e6be4f6b); this makes its failures visible and abstains
 * where it cannot tell, which is that replacement's prerequisite.
 *
 * Removal plan (kanban t_1459706f): once the upstream PR merges and the
 * deployed Hermes emits `parent_session_id`, delete this file and every
 * call site carrying the CRUTCH(t_1459706f) marker; the native payload
 * path in `resolve.ts` already takes precedence.
 */

import type { GitWorkspaceIdentity } from "../git/reader.ts";
import {
  CRUTCH_LINK_WINDOW_MS,
  type LineageLedgerEntry,
  type LineageLedgerState,
} from "./ledger.ts";
import type { SessionLineage } from "./types.ts";

/**
 * Closed vocabulary of continuation refusals. Every member names a
 * DIFFERENT cause, which is the whole point: `no-candidate` (nothing to
 * link to) and `ambiguous` (too much to link to) are opposite
 * conditions that the previous `null` return made indistinguishable.
 */
export const CRUTCH_ABSTENTION = Object.freeze({
  /** Nothing in the ledger reached the freshness or evidence gates. */
  noCandidate: "no-candidate",
  /** This session already has ledger history of its own: parallel, not a continuation. */
  selfKnown: "self-known",
  /** The host reported no working directory, so no candidate set can be formed. */
  noWorkspace: "no-workspace",
  /** Several candidates survived every predicate. Refused rather than resolved by recency. */
  ambiguous: "ambiguous",
  /** Candidates existed in this workspace but all fell outside the freshness window. */
  stale: "stale",
  /** Candidates were fresh but showed no compression boundary, or their git state was unattested. */
  evidenceMissing: "evidence-missing",
} as const);

export type CrutchAbstentionReason = (typeof CRUTCH_ABSTENTION)[keyof typeof CRUTCH_ABSTENTION];

/** A link was inferred. */
export interface CrutchLinked {
  readonly kind: "linked";
  readonly lineage: SessionLineage;
}

/** No link was inferred, and this is why. */
export interface CrutchAbstained {
  readonly kind: "abstained";
  readonly reason: CrutchAbstentionReason;
  /** One English line stating the counts behind the refusal. */
  readonly detail: string;
  /** Predecessors in this workspace that were examined. */
  readonly considered: number;
}

export type CrutchOutcome = CrutchLinked | CrutchAbstained;

export interface CrutchResolveInput {
  readonly sessionId: string;
  /** Working directory the host reported, if any. */
  readonly cwd?: string;
  readonly ledger: LineageLedgerState;
  /** Injected clock (epoch ms). */
  readonly nowMs: number;
  /** Git working state of THIS session, when its `cwd` attested one. */
  readonly workspace?: GitWorkspaceIdentity;
  /**
   * Sessions the ledger's gap sidecar records as having spoken without
   * being appended (`lineageGapSessionIds`). Membership is evidence of
   * own history exactly as a ledger line is - see Rule 1 above. Omitted
   * means "no gap evidence available", which is the pre-existing
   * behaviour and the only reason the field is optional.
   */
  readonly gapSessionIds?: ReadonlySet<string>;
}

/**
 * How two attestations relate. `unattested` is neither agreement nor
 * disagreement: exactly one side made a claim (or neither did while the
 * other could have), so the working state is unverified rather than
 * different - a distinction the caller reports as missing evidence
 * instead of as a mismatch.
 */
type AttestationMatch = "match" | "mismatch" | "unattested";

/** Which predicate turned a candidate away. Ordered by how far it got. */
type RejectionKind = "claimed" | "workspace" | "stale" | "evidence";

/**
 * Infer lineage for a session from the ledger, or abstain with a named
 * reason. CRUTCH(t_1459706f). Never throws.
 */
export function resolveCrutchLineage(input: CrutchResolveInput): CrutchOutcome {
  const { sessionId, ledger, nowMs } = input;

  const own = ledger.get(sessionId);
  // A previously persisted link (from an earlier crutch or payload
  // resolution) is authoritative for the rest of the session.
  if (own?.lineage !== undefined && own.lineage.source !== "flat") {
    return Object.freeze({ kind: "linked" as const, lineage: own.lineage });
  }
  // Rule 1: known session without a link = parallel session, not a
  // continuation. Never re-guess.
  if (own !== undefined) {
    return abstain(
      CRUTCH_ABSTENTION.selfKnown,
      "the session already has ledger history without a link",
      0,
    );
  }
  // Rule 1, second half. A ledger LINE is only one of the two records
  // that a session already spoke; a writer-lock drop leaves the other -
  // a gap in the sidecar. Reading the ledger alone makes a session whose
  // observation was dropped indistinguishable from one that never
  // spoke, which turns this fail-closed rule into a FALSE STITCH onto an
  // unrelated parallel session. Absent evidence is evidence, once it is
  // recorded that it was lost.
  if (input.gapSessionIds?.has(sessionId) === true) {
    return abstain(
      CRUTCH_ABSTENTION.selfKnown,
      "the session has a recorded ledger gap: it spoke, and the observation was dropped",
      0,
    );
  }
  const cwd = input.cwd;
  if (cwd === undefined || cwd.length === 0) {
    return abstain(CRUTCH_ABSTENTION.noWorkspace, "the host reported no working directory", 0);
  }

  const survivors: LineageLedgerEntry[] = [];
  const rejected: Record<RejectionKind, number> = {
    claimed: 0,
    workspace: 0,
    stale: 0,
    evidence: 0,
  };
  let considered = 0;
  const claimed = claimedPredecessors(ledger, sessionId);

  for (const entry of ledger.values()) {
    if (entry.sessionId === sessionId) continue;
    // Rule 2. A different directory is a different piece of work, not a
    // near miss, so it never enters the candidate count.
    if (entry.cwd !== cwd) continue;
    considered++;

    // A compaction boundary has exactly one successor, so a
    // predecessor another session already continued from is spoken for.
    // Without this, an A -> B -> C chain looks ambiguous from C: both A
    // and B are fresh, evidenced and in the same directory, and only B
    // is actually available.
    if (claimed.has(entry.sessionId)) {
      rejected.claimed++;
      continue;
    }

    // Rule 3, part one: an attested disagreement about repo, branch or
    // commit is decisive - this is a different working state.
    const attestation = compareWorkspace(entry.workspace, input.workspace);
    if (attestation === "mismatch") {
      rejected.workspace++;
      continue;
    }
    // Rule 5.
    const age = nowMs - entry.lastSeenMs;
    if (age < 0 || age > CRUTCH_LINK_WINDOW_MS) {
      rejected.stale++;
      continue;
    }
    // Rule 4.
    if (!entry.compressionEvidence) {
      rejected.evidence++;
      continue;
    }
    // Rule 3, part two: one-sided attestation is an unverifiable claim.
    if (attestation === "unattested") {
      rejected.evidence++;
      continue;
    }
    survivors.push(entry);
  }

  // Rule 6.
  if (survivors.length > 1) {
    return abstain(
      CRUTCH_ABSTENTION.ambiguous,
      `${survivors.length} predecessors survived every predicate in the same working state; ` +
        "refused rather than resolved by recency",
      considered,
    );
  }
  const predecessor = survivors[0];
  if (predecessor === undefined) {
    return abstain(nearestMiss(rejected), summarize(considered, rejected), considered);
  }

  const parentLineage = predecessor.lineage;
  return Object.freeze({
    kind: "linked" as const,
    lineage: Object.freeze({
      rootId: parentLineage !== undefined ? parentLineage.rootId : predecessor.sessionId,
      parentId: predecessor.sessionId,
      depth: (parentLineage !== undefined ? parentLineage.depth : 0) + 1,
      source: "crutch" as const,
    }),
  });
}

function abstain(
  reason: CrutchAbstentionReason,
  detail: string,
  considered: number,
): CrutchAbstained {
  return Object.freeze({ kind: "abstained" as const, reason, detail, considered });
}

/**
 * Report the NEAREST MISS. A candidate rejected on evidence got further
 * through the predicate chain than one rejected on freshness, which got
 * further than one whose working state disagreed - so naming the
 * furthest tells the operator what actually stood between two sessions.
 */
function nearestMiss(rejected: Record<RejectionKind, number>): CrutchAbstentionReason {
  if (rejected.evidence > 0) return CRUTCH_ABSTENTION.evidenceMissing;
  if (rejected.stale > 0) return CRUTCH_ABSTENTION.stale;
  return CRUTCH_ABSTENTION.noCandidate;
}

function summarize(considered: number, rejected: Record<RejectionKind, number>): string {
  if (considered === 0) return "no predecessor was recorded in this working directory";
  return (
    `no predecessor survived: ${considered} examined ` +
    `(${rejected.claimed} already continued, ${rejected.workspace} in another working state, ` +
    `${rejected.stale} outside the freshness window, ` +
    `${rejected.evidence} without usable evidence)`
  );
}

/**
 * Session ids that some OTHER ledger entry already names as its parent.
 * Membership means the compaction boundary out of that session has been
 * taken; a second successor would be a fork, which the crutch has no
 * evidence to justify.
 */
function claimedPredecessors(ledger: LineageLedgerState, sessionId: string): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const entry of ledger.values()) {
    if (entry.sessionId === sessionId) continue;
    const parentId = entry.lineage?.parentId;
    if (typeof parentId === "string" && parentId.length > 0) claimed.add(parentId);
  }
  return claimed;
}

/**
 * Compare the git working state of a candidate against this session's.
 *
 * Both sides silent is a MATCH: a workspace outside any repository can
 * attest nothing, and refusing every non-git directory would disable
 * continuation there rather than harden it. One side silent is
 * `unattested` - including the migration case where the predecessor was
 * recorded before this evidence existed, which self-heals within one
 * freshness window as new observations land.
 */
function compareWorkspace(
  candidate: GitWorkspaceIdentity | undefined,
  session: GitWorkspaceIdentity | undefined,
): AttestationMatch {
  if (candidate === undefined && session === undefined) return "match";
  if (candidate === undefined || session === undefined) return "unattested";

  let agreed = 0;
  let oneSided = false;
  for (const field of ["repo", "branch", "commit"] as const) {
    const a = candidate[field];
    const b = session[field];
    if (a === null && b === null) continue;
    if (a === null || b === null) {
      oneSided = true;
      continue;
    }
    if (a !== b) return "mismatch";
    agreed++;
  }
  if (oneSided || agreed === 0) return "unattested";
  return "match";
}
