/**
 * The ask-once batching layer over the undistilled backlog
 * (session-mining-economy, t_0358af42).
 *
 * Vault-wide cross-session dedup already ships at WRITE time
 * (`buildDedupIndex` plus the commit-time gate): a recurring fact is
 * written once, whatever number of sessions raised it. What shipped
 * nowhere was dedup of the ASK - the operator was still asked about the
 * same material once per session that raised it, because suppression
 * happened only after the proposal reached the write gate.
 *
 * `buildBacklogProposals` is the pure core that moves dedup before the
 * ask. It takes the pending distill candidates raised by undistilled
 * sessions plus a `loadDedupIndex` result, drops every candidate whose
 * `computeDedupHash` already exists in the vault (naming each drop), and
 * collapses the remainder to ONE proposal per distinct hash across
 * sessions, naming every contributing session. The output is one batched
 * envelope for the calling agent to present; the kernel stays LLM-free
 * and runs no interactive loop - it groups, it does not ask.
 *
 * A session whose every candidate was already known appears in
 * `reportOnlySessions` and in no proposal: the report says "known,
 * nothing new" about it, which is a different statement from proposing
 * its material again.
 */

import { computeDedupHash, type DedupIndexEntry } from "../dedup-hash.ts";

/** One pending distill candidate raised by an undistilled backlog session. */
export interface BacklogCandidate {
  /** The portable session identity that raised the candidate. */
  readonly sessionId: string;
  readonly topic: string;
  readonly signal: "positive" | "negative";
  readonly principle: string;
  readonly scope?: string;
}

/** One candidate suppressed from the ask because the vault already holds it. */
export interface BacklogProposalDrop {
  readonly sessionId: string;
  readonly topic: string;
  readonly dedupHash: string;
}

/** One ask-once proposal: everything the vault does not yet hold, per hash. */
export interface BacklogProposal {
  readonly dedupHash: string;
  /** The first candidate's fields, as the proposal's representative form. */
  readonly topic: string;
  readonly signal: "positive" | "negative";
  readonly principle: string;
  readonly scope?: string;
  /** Every session that raised this hash, sorted, unique. */
  readonly sessions: ReadonlyArray<string>;
}

/** The batched envelope: what to ask, what was suppressed, who raised nothing new. */
export interface BacklogProposals {
  readonly proposals: ReadonlyArray<BacklogProposal>;
  readonly dropped: ReadonlyArray<BacklogProposalDrop>;
  /** Sessions whose every candidate was already known. Sorted. */
  readonly reportOnlySessions: ReadonlyArray<string>;
}

/**
 * Batch the pending candidates ask-once. Empty input is an explicit empty
 * envelope, not silence. Deterministic: proposals sort by dedup hash,
 * drops by session then topic, so two runs over the same backlog agree
 * byte for byte regardless of the input order.
 */
export function buildBacklogProposals(
  pending: ReadonlyArray<BacklogCandidate>,
  dedupIndex: ReadonlyMap<string, DedupIndexEntry>,
): BacklogProposals {
  const dropped: BacklogProposalDrop[] = [];
  const sessionsByHash = new Map<string, Set<string>>();
  const representativeByHash = new Map<string, BacklogCandidate>();
  const sessionsWithProposals = new Set<string>();

  for (const candidate of pending) {
    const hash = computeDedupHash({
      topic: candidate.topic,
      signal: candidate.signal,
      principle: candidate.principle,
      scope: candidate.scope,
    });
    if (dedupIndex.has(hash)) {
      dropped.push({ sessionId: candidate.sessionId, topic: candidate.topic, dedupHash: hash });
      continue;
    }
    let sessions = sessionsByHash.get(hash);
    if (sessions === undefined) {
      sessions = new Set();
      sessionsByHash.set(hash, sessions);
      representativeByHash.set(hash, candidate);
    }
    sessions.add(candidate.sessionId);
    sessionsWithProposals.add(candidate.sessionId);
  }

  const raised = new Set(pending.map((candidate) => candidate.sessionId));
  const reportOnlySessions = [...raised]
    .filter((sessionId) => !sessionsWithProposals.has(sessionId))
    .toSorted();

  const proposals: BacklogProposal[] = [...sessionsByHash.keys()].toSorted().map((hash) => {
    const representative = representativeByHash.get(hash)!;
    return {
      dedupHash: hash,
      topic: representative.topic,
      signal: representative.signal,
      principle: representative.principle,
      ...(representative.scope !== undefined ? { scope: representative.scope } : {}),
      sessions: [...sessionsByHash.get(hash)!].toSorted(),
    };
  });
  dropped.sort((a, b) =>
    a.sessionId === b.sessionId
      ? a.topic === b.topic
        ? a.dedupHash.localeCompare(b.dedupHash)
        : a.topic.localeCompare(b.topic)
      : a.sessionId.localeCompare(b.sessionId),
  );

  return { proposals, dropped, reportOnlySessions };
}
