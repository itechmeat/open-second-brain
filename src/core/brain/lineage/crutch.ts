/**
 * CRUTCH(t_1459706f) - interim session-lineage inference.
 *
 * The deployed Hermes collapses `parent_session_id` into `session_id`
 * in its shell-hook payload (`_serialize_payload`) and exposes no
 * lineage field; upstream PR NousResearch/hermes-agent#42940 adds the
 * native field but has not merged. Until it ships, this module infers
 * the parent of a brand-new session id from the lineage ledger.
 *
 * ## Two rungs (signals-that-survive, Unit 9)
 *
 * Resolution here runs two rungs in strict order. The first is DURABLE
 * WORK IDENTITY: when this session and exactly one predecessor declared
 * the same work id, they are the same work item and the link is made on
 * that alone - no freshness bound, no `cwd`, branch or commit predicate,
 * which is precisely what lets resumed work re-attach after a model,
 * account, branch or worktree switch. The identity is DECLARED (see
 * `identity.ts`); nothing is inferred from structure. The second rung is
 * the timing crutch below, unchanged, and it still decides every session
 * that declares nothing.
 *
 * A LANE is a hard separator across both rungs: two entries carrying
 * different declared lane ids never link, whatever else they share, and
 * the refusal is the named `lane-conflict` outcome rather than a silent
 * non-link. It is never a tiebreak - a lane cannot make an otherwise
 * refused link happen, only prevent one.
 *
 * The crutch's own inference is deliberately conservative - a false
 * stitch (two unrelated conversations merged) is strictly worse than a
 * missed stitch (status quo). A link happens only when ALL hold:
 *
 *   1. the new session has NO history of its own - neither a ledger
 *      line NOR a recorded gap (a session seen before without a link is
 *      a parallel session, and a dropped observation is still a session
 *      that spoke);
 *   2. a predecessor exists in the SAME cwd, no other session has
 *      already continued from it, and it declares no lane that
 *      contradicts this session's;
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
 * The 900-second window stays as the freshness bound for the second
 * rung, and is the ONLY resolution path available when nothing declares
 * an identity - which is why Unit 9 demoted it rather than deleting it.
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
  /**
   * A predecessor was available and carried a DIFFERENT declared lane.
   * The hard separator fired: this is a refusal, never a near miss, and
   * it is named so a lane typo is distinguishable from an absence of
   * history (Unit 9).
   */
  laneConflict: "lane-conflict",
  /**
   * Several predecessors declare THIS session's work id under the same
   * lane. The identity rung refuses for the same reason `ambiguous`
   * does - a shared id that names more than one predecessor cannot pick
   * one without guessing (Unit 9).
   */
  workAmbiguous: "work-ambiguous",
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
  /**
   * DECLARED work id of THIS session (Unit 9), resolved at the capture
   * boundary. Absent means the identity rung has nothing to match on and
   * the window rung decides alone - which is the pre-Unit-9 behaviour.
   */
  readonly workId?: string;
  /** DECLARED lane of THIS session. The hard separator, at both rungs. */
  readonly laneId?: string;
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
type RejectionKind = "claimed" | "lane" | "workspace" | "stale" | "evidence";

/**
 * Resolve lineage for a session from the ledger, or abstain with a named
 * reason. Runs the declared-identity rung first and the timing crutch
 * second. CRUTCH(t_1459706f). Never throws.
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
  // A compaction boundary has exactly one successor, so a predecessor
  // another session already continued from is spoken for. Computed once
  // and shared by both rungs - the property is the same at each.
  const claimed = claimedPredecessors(ledger, sessionId);

  // RUNG 1 (Unit 9): durable declared identity. It returns null when it
  // has nothing to decide on, which is when the window rung below runs.
  const byIdentity = resolveDeclaredIdentity(input, claimed);
  if (byIdentity !== null) return byIdentity;

  // RUNG 2: the timing crutch. Unchanged apart from the lane separator.
  const cwd = input.cwd;
  if (cwd === undefined || cwd.length === 0) {
    return abstain(CRUTCH_ABSTENTION.noWorkspace, "the host reported no working directory", 0);
  }

  const survivors: LineageLedgerEntry[] = [];
  const rejected: Record<RejectionKind, number> = {
    claimed: 0,
    lane: 0,
    workspace: 0,
    stale: 0,
    evidence: 0,
  };
  let considered = 0;

  for (const entry of ledger.values()) {
    if (entry.sessionId === sessionId) continue;
    // Rule 2. A different directory is a different piece of work, not a
    // near miss, so it never enters the candidate count.
    if (entry.cwd !== cwd) continue;
    considered++;

    // Without this, an A -> B -> C chain looks ambiguous from C: both A
    // and B are fresh, evidenced and in the same directory, and only B
    // is actually available.
    if (claimed.has(entry.sessionId)) {
      rejected.claimed++;
      continue;
    }

    // The lane separator (Unit 9) applies to this rung too. Without it a
    // predecessor the identity rung just refused could be re-linked here
    // on nothing but a shared directory and a fresh timestamp, which
    // would make "never link across lanes" true of one rung only.
    if (lanesConflict(entry.laneId, input.laneId)) {
      rejected.lane++;
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
  return linkTo(predecessor, CRUTCH_SOURCE);
}

/** Lineage source recorded by each of the two rungs. */
const IDENTITY_SOURCE = "identity" as const;
const CRUTCH_SOURCE = "crutch" as const;

/**
 * Continue a predecessor's conversation. Shared by both rungs so the
 * root/depth inheritance is written once: a predecessor that is itself
 * a continuation passes on its ROOT, not its own id, and its depth
 * count continues rather than restarting.
 */
function linkTo(predecessor: LineageLedgerEntry, source: SessionLineage["source"]): CrutchLinked {
  const parentLineage = predecessor.lineage;
  return Object.freeze({
    kind: "linked" as const,
    lineage: Object.freeze({
      rootId: parentLineage !== undefined ? parentLineage.rootId : predecessor.sessionId,
      parentId: predecessor.sessionId,
      depth: (parentLineage !== undefined ? parentLineage.depth : 0) + 1,
      source,
    }),
  });
}

/**
 * RUNG 1: link on a DECLARED work id alone (Unit 9).
 *
 * Deliberately applies none of the crutch's predicates. Freshness, cwd,
 * repo, branch, commit and compression evidence are all proxies for "is
 * this the same work" that the declaration answers directly - so a
 * resumed item re-attaches after a switch that would fail every one of
 * them. What it does NOT relax: the lane separator, the spoken-for rule,
 * and the refusal to guess between several candidates.
 *
 * "Declared" is load-bearing and is enforced UPSTREAM, in `identity.ts`:
 * a payload or environment declaration reaches here unbounded, while an
 * identity merely INHERITED from a worktree marker stops being supplied
 * once the marker passes its staleness bound. Without that, this rung's
 * deliberate absence of a freshness predicate would let one directory's
 * first declaration chain every later conversation there onto it.
 *
 * Returns `null` when this rung has nothing to decide - the session
 * declared no work id, or no predecessor declared the same one - which
 * is the only path down to the window rung. Every other outcome is
 * terminal, including the two refusals: falling through after naming a
 * lane conflict would let the window rung silently re-link what the
 * separator just refused.
 */
function resolveDeclaredIdentity(
  input: CrutchResolveInput,
  claimed: ReadonlySet<string>,
): CrutchOutcome | null {
  const workId = input.workId;
  if (workId === undefined || workId.length === 0) return null;

  const survivors: LineageLedgerEntry[] = [];
  let considered = 0;
  let laneRejected = 0;
  for (const entry of input.ledger.values()) {
    if (entry.sessionId === input.sessionId) continue;
    if (entry.workId !== workId) continue;
    considered++;
    // Spoken for BEFORE lane, and the order is load-bearing: a
    // predecessor another session already continued from is not
    // available to anyone, so counting it as a lane refusal would raise
    // a TERMINAL `lane-conflict` abstention over a candidate that was
    // never a candidate - and that abstention hides the legitimate
    // window-rung link below it.
    if (claimed.has(entry.sessionId)) continue;
    if (lanesConflict(entry.laneId, input.laneId)) {
      laneRejected++;
      continue;
    }
    survivors.push(entry);
  }

  // Ambiguity abstains here for the same reason it does at the window
  // rung: a shared id naming two predecessors cannot pick one without
  // guessing, and a wrong-but-plausible resume is worse than none.
  if (survivors.length > 1) {
    return abstain(
      CRUTCH_ABSTENTION.workAmbiguous,
      `${survivors.length} predecessors declare work id ${workId} in this lane; ` +
        "refused rather than resolved by recency",
      considered,
    );
  }
  const predecessor = survivors[0];
  if (predecessor !== undefined) return linkTo(predecessor, IDENTITY_SOURCE);
  if (laneRejected > 0) {
    return abstain(
      CRUTCH_ABSTENTION.laneConflict,
      `${laneRejected} of ${considered} predecessors declaring work id ${workId} ` +
        "carry a different lane; lanes never link",
      considered,
    );
  }
  // Either nothing declared this work id, or every match was already
  // continued from. Both leave the window rung to decide and report.
  return null;
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
  // The lane separator outranks the near-miss ordering: it is a
  // DECLARED refusal rather than a predicate a candidate fell short of,
  // and reporting it as "no candidate" would hide the one cause an
  // operator can act on directly.
  if (rejected.lane > 0) return CRUTCH_ABSTENTION.laneConflict;
  if (rejected.evidence > 0) return CRUTCH_ABSTENTION.evidenceMissing;
  if (rejected.stale > 0) return CRUTCH_ABSTENTION.stale;
  return CRUTCH_ABSTENTION.noCandidate;
}

/**
 * One English line stating the counts behind a refusal. The lane clause
 * appears only when a lane actually refused something: lanes are opt-in,
 * and reporting "0 in another lane" to a vault where nobody declares one
 * changes the operator-visible line for a feature that is not in use.
 */
function summarize(considered: number, rejected: Record<RejectionKind, number>): string {
  if (considered === 0) return "no predecessor was recorded in this working directory";
  return (
    `no predecessor survived: ${considered} examined ` +
    `(${rejected.claimed} already continued, ` +
    (rejected.lane > 0 ? `${rejected.lane} in another lane, ` : "") +
    `${rejected.workspace} in another working state, ` +
    `${rejected.stale} outside the freshness window, ` +
    `${rejected.evidence} without usable evidence)`
  );
}

/**
 * True when two DECLARED lanes disagree. One side silent is not a
 * conflict: a lane is a separator a caller opts into, so an undeclared
 * lane must leave resolution exactly as it was before lanes existed.
 */
function lanesConflict(candidate: string | undefined, session: string | undefined): boolean {
  return candidate !== undefined && session !== undefined && candidate !== session;
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
