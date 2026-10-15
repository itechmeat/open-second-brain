/**
 * The ask-once batching layer over the undistilled backlog
 * (session-mining-economy, t_0358af42).
 *
 * Dedup happens before the ASK, not before the write: the write-time gates
 * in `extract-signals.ts` and the import path already suppress duplicate
 * WRITES, but nothing collapsed the ask - a recurring fact was re-proposed
 * to the operator once per session that raised it. `buildBacklogProposals`
 * is the pure core that fixes the ask: candidates whose dedup hash already
 * exists in the vault are dropped from the ask (each drop named), the
 * remainder collapses to one proposal per distinct hash across sessions,
 * and the whole batch is one envelope for the calling agent to present.
 * The kernel stays LLM-free and runs no interactive loop: it groups, it
 * does not ask.
 */

import { describe, expect, test } from "bun:test";

import { computeDedupHash, type DedupIndexEntry } from "../../../../src/core/brain/dedup-hash.ts";
import {
  buildBacklogProposals,
  type BacklogCandidate,
} from "../../../../src/core/brain/distill/backlog-proposals.ts";

function candidate(overrides: Partial<BacklogCandidate> = {}): BacklogCandidate {
  return {
    sessionId: "alpha.jsonl",
    topic: "declare roots once",
    signal: "positive",
    principle: "Declare the roots exactly once.",
    ...overrides,
  };
}

function indexWith(...candidates: BacklogCandidate[]): Map<string, DedupIndexEntry> {
  const out = new Map<string, DedupIndexEntry>();
  for (const raised of candidates) {
    const hash = computeDedupHash({
      topic: raised.topic,
      signal: raised.signal,
      principle: raised.principle,
      scope: raised.scope,
    });
    out.set(hash, {
      id: `sig-${hash.slice(0, 8)}`,
      path: `Brain/inbox/sig-${hash.slice(0, 8)}.md`,
    });
  }
  return out;
}

function hashOf(raised: BacklogCandidate): string {
  return computeDedupHash({
    topic: raised.topic,
    signal: raised.signal,
    principle: raised.principle,
    scope: raised.scope,
  });
}

describe("buildBacklogProposals", () => {
  test("an empty backlog is an explicit empty result", () => {
    expect(buildBacklogProposals([], new Map())).toEqual({
      proposals: [],
      dropped: [],
      reportOnlySessions: [],
    });
  });

  test("unknown material becomes one proposal naming its session and hash", () => {
    const pending = [candidate()];
    const result = buildBacklogProposals(pending, new Map());
    expect(result.dropped).toEqual([]);
    expect(result.reportOnlySessions).toEqual([]);
    expect(result.proposals).toEqual([
      {
        dedupHash: hashOf(pending[0]!),
        topic: "declare roots once",
        signal: "positive",
        principle: "Declare the roots exactly once.",
        sessions: ["alpha.jsonl"],
      },
    ]);
  });

  test("the same material raised by several sessions collapses to one proposal", () => {
    const pending = [
      candidate(),
      candidate({ sessionId: "beta.jsonl" }),
      candidate({ sessionId: "gamma.jsonl" }),
    ];
    const result = buildBacklogProposals(pending, new Map());
    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0]?.sessions).toEqual(["alpha.jsonl", "beta.jsonl", "gamma.jsonl"]);
  });

  test("material the vault already has is dropped from the ask, named", () => {
    const known = candidate();
    const pending = [known, candidate({ topic: "brand new rule", principle: "Write it down." })];
    const result = buildBacklogProposals(pending, indexWith(known));
    expect(result.proposals.map((p) => p.topic)).toEqual(["brand new rule"]);
    expect(result.dropped).toEqual([
      { sessionId: "alpha.jsonl", topic: "declare roots once", dedupHash: hashOf(known) },
    ]);
    // The session raised known AND new material, so it is not report-only.
    expect(result.reportOnlySessions).toEqual([]);
  });

  test("a session raising only already-known material appears in the report and in no proposal", () => {
    const knownA = candidate();
    const knownB = candidate({
      sessionId: "beta.jsonl",
      topic: "never paste tokens",
      principle: "Redact.",
    });
    const fresh = candidate({
      sessionId: "beta.jsonl",
      topic: "fresh rule",
      principle: "Brand new.",
    });
    // beta raises one known candidate and one fresh one; alpha raises only
    // the known one.
    const pending = [knownA, knownB, fresh];
    const result = buildBacklogProposals(pending, indexWith(knownA, knownB));
    expect(result.proposals.map((p) => p.sessions)).toEqual([["beta.jsonl"]]);
    expect(result.reportOnlySessions).toEqual(["alpha.jsonl"]);
    expect(result.dropped.length).toBe(2);
  });

  test("scope participates in the identity: same rule, different scope, two proposals", () => {
    const pending = [candidate({ scope: "project-a" }), candidate({ scope: "project-b" })];
    const result = buildBacklogProposals(pending, new Map());
    expect(result.proposals.length).toBe(2);
    expect(result.proposals.map((p) => p.scope).toSorted()).toEqual(["project-a", "project-b"]);
  });

  test("a candidate with no scope and one with an empty scope share a hash", () => {
    const pending = [candidate(), candidate({ sessionId: "beta.jsonl", scope: "" })];
    const result = buildBacklogProposals(pending, new Map());
    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0]?.sessions).toEqual(["alpha.jsonl", "beta.jsonl"]);
  });

  test("the result is deterministic: proposals by hash, drops by session then topic", () => {
    const known = candidate({ topic: "known rule", principle: "Known." });
    const alsoKnown = candidate({
      sessionId: "beta.jsonl",
      topic: "another known",
      principle: "Also known.",
    });
    const pending = [
      candidate({ topic: "second", principle: "Two." }),
      candidate({ sessionId: "beta.jsonl", topic: "first", principle: "One." }),
      alsoKnown,
      known,
    ];
    const first = buildBacklogProposals(pending, indexWith(known, alsoKnown));
    const second = buildBacklogProposals(pending.toReversed(), indexWith(known, alsoKnown));
    expect(first).toEqual(second);
    const hashes = first.proposals.map((p) => p.dedupHash);
    expect(hashes).toEqual([...hashes].toSorted());
    expect(first.proposals.map((p) => p.topic).toSorted()).toEqual(["first", "second"]);
    expect(first.dropped.map((d) => [d.sessionId, d.topic])).toEqual([
      ["alpha.jsonl", "known rule"],
      ["beta.jsonl", "another known"],
    ]);
  });
});
