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
  /**
   * The representative form of the hash class: the candidate whose
   * (topic, signal, principle, scope) tuple sorts first within the class,
   * so the proposal text cannot depend on the caller's input order. The
   * dedup hash normalizes case and width, so one class can hold
   * candidates whose raw fields differ.
   */
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
 * envelope, not silence. Deterministic: proposals sort by dedup hash, each
 * proposal's representative fields are the content-stable pick within its
 * hash class, drops sort by session then topic, so two runs over the same
 * backlog agree byte for byte regardless of the input order.
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
    }
    const current = representativeByHash.get(hash);
    if (current === undefined || precedes(candidate, current)) {
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
      // The hash unifies a missing scope with an empty one, so the
      // representative's raw empty string is dropped too: a proposal that
      // carried it or not depending on which candidate won the class
      // would not be byte-for-byte deterministic.
      ...(representative.scope ? { scope: representative.scope } : {}),
      sessions: [...sessionsByHash.get(hash)!].toSorted(),
    };
  });
  dropped.sort(compareDrops);

  return { proposals, dropped, reportOnlySessions };
}

/** Drops in (session, topic, dedup hash) order. */
function compareDrops(a: BacklogProposalDrop, b: BacklogProposalDrop): number {
  if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
  if (a.topic !== b.topic) return a.topic.localeCompare(b.topic);
  return a.dedupHash.localeCompare(b.dedupHash);
}

/**
 * Whether `a`'s (topic, signal, principle, scope) tuple sorts before `b`'s,
 * field by field in code-unit order. The missing and the empty scope
 * compare equal, mirroring the dedup hash's own unification, so a class
 * whose members differ only there still picks one representative whatever
 * the input order.
 */
function precedes(a: BacklogCandidate, b: BacklogCandidate): boolean {
  if (a.topic !== b.topic) return a.topic < b.topic;
  if (a.signal !== b.signal) return a.signal < b.signal;
  if (a.principle !== b.principle) return a.principle < b.principle;
  const aScope = a.scope ?? "";
  const bScope = b.scope ?? "";
  return aScope < bScope;
}
