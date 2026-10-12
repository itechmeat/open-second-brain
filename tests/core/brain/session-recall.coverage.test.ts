/**
 * Coverage-first session recall (recall-quality wave, Lane B / t_2c2a883c).
 *
 * The coverage operation is the retrieve-wide-then-compress pass over the
 * lineage-scoped record set: facets detected from the thread itself, a
 * fan-out per facet, the union ranked by relevance, budgeted, and
 * re-emitted in `compareRecords` chronological order with diagnostics
 * recomputable from the record set. A grep call without the new
 * operation stays byte-identical (the omitted-operation convention, cf.
 * `includeRaw`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";
import {
  coverageSessionRecall,
  importSessionRecall,
  listSessionRawTurns,
  searchSessionRecall,
  SessionCoverageEntityUnknownError,
  SessionCoverageInfeasibleError,
} from "../../../src/core/brain/session-recall.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-recall-coverage-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function turn(
  turnId: string,
  role: SessionTurn["role"],
  text: string,
  second: number,
): SessionTurn {
  return {
    turnId,
    role,
    text,
    timestamp: `2026-07-01T09:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`,
  };
}

/** Two lineage-linked segments; four turns each, two depth-1 clusters per segment. */
function importLineageThread(): void {
  importSessionRecall(vault, {
    sessionId: "root-seg",
    turns: [
      turn("t1", "user", "alpha question about receipts before compaction", 1),
      turn("t2", "assistant", "alpha answer about receipts before compaction", 2),
      turn("t3", "user", "beta question about invoices before compaction", 3),
      turn("t4", "assistant", "beta answer about invoices before compaction", 4),
    ],
    summaryGroupSize: 2,
    createdAt: "2026-07-01T09:00:10.000Z",
  });
  importSessionRecall(vault, {
    sessionId: "child-seg",
    turns: [
      turn("t5", "user", "gamma question about refunds after compaction", 61),
      turn("t6", "assistant", "gamma answer about refunds after compaction", 62),
      turn("t7", "user", "delta question about credits after compaction", 63),
      turn("t8", "assistant", "delta answer about credits after compaction", 64),
    ],
    summaryGroupSize: 2,
    createdAt: "2026-07-01T09:01:10.000Z",
    lineage: { rootId: "root-seg", parentId: "root-seg", depth: 1, source: "payload" },
  });
}

describe("coverage-first selection core", () => {
  test("returns turns touching every detected facet, chronologically, with recomputable diagnostics", () => {
    importLineageThread();

    const coverage = coverageSessionRecall(vault, {
      sessionId: "child-seg",
      charBudget: 100_000,
    });

    // Every depth-1 cluster's turns are covered: the four clusters
    // partition the eight turns, so all eight turns come back.
    expect(coverage.turns.map((t) => t.turn_id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ]);

    const diagnostics = coverage.diagnostics;
    expect(diagnostics.facets_detected).toBe(4);
    expect(diagnostics.topics_realized).toBe(4);
    expect(diagnostics.chars_used).toBeGreaterThan(0);
    expect(diagnostics.dropped_turn_ids).toEqual([]);

    // Recomputable: the topic keys are exactly the in-scope depth-1
    // summary node ids, derivable from the record set alone.
    const depthOneIds = listContinuityRecords(vault)
      .filter((record) => record.kind === "session_summary_node" && record.payload["depth"] === 1)
      .map((record) => record.id)
      .toSorted();
    expect(diagnostics.topics.map((topic) => topic.key).toSorted()).toEqual(
      depthOneIds.map((id) => `cluster:${id}`).toSorted(),
    );
    expect(diagnostics.topics.every((topic) => topic.turn_count === 2)).toBe(true);
    // The adaptive topic budget: four facets floor at 12, and the
    // diagnostics report the four realized topics honestly.
    expect(diagnostics.topics_requested).toBe(12);
  });

  test("coverage across the lineage boundary reaches the root segment from the child id", () => {
    importLineageThread();
    const coverage = coverageSessionRecall(vault, { sessionId: "root-seg", charBudget: 100_000 });
    expect(coverage.turns.map((t) => t.turn_id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ]);
  });

  test("a scope with no coverage-bearing records returns an honest empty result", () => {
    importLineageThread();
    const coverage = coverageSessionRecall(vault, {
      sessionId: "no-such-session",
      charBudget: 100_000,
    });
    expect(coverage.turns).toEqual([]);
    expect(coverage.diagnostics.facets_detected).toBe(0);
    expect(coverage.diagnostics.topics_realized).toBe(0);
    expect(coverage.diagnostics.chars_used).toBe(0);
  });

  test("a non-positive character budget is refused by name", () => {
    importLineageThread();
    expect(() => coverageSessionRecall(vault, { sessionId: "root-seg", charBudget: 0 })).toThrow(
      /must be a positive finite number/,
    );
  });
});

describe("adaptive topic budget over coverage", () => {
  function importFacetThread(facets: number): void {
    importSessionRecall(vault, {
      sessionId: "facet-seg",
      turns: Array.from({ length: facets }, (_, index) =>
        turn(`t${index + 1}`, "user", `topic ${index + 1} distinct material`, index + 1),
      ),
      summaryGroupSize: 1,
      createdAt: "2026-07-02T09:00:00.000Z",
    });
  }

  test("a 40-facet thread caps the budget at 16", () => {
    importFacetThread(40);
    const coverage = coverageSessionRecall(vault, {
      sessionId: "facet-seg",
      charBudget: 1_000_000,
    });
    expect(coverage.diagnostics.facets_detected).toBe(40);
    expect(coverage.diagnostics.topics_requested).toBe(16);
    expect(coverage.diagnostics.topics_realized).toBe(16);
    // Groups of one: each realized cluster establishes exactly one turn,
    // so the capped fan-out reaches the first 16 turns of the thread.
    expect(coverage.turns).toHaveLength(16);
  });

  test("a 3-facet thread floors at 12 and reports 3 realized topics honestly", () => {
    importFacetThread(3);
    const coverage = coverageSessionRecall(vault, { sessionId: "facet-seg", charBudget: 100_000 });
    expect(coverage.diagnostics.topics_requested).toBe(12);
    expect(coverage.diagnostics.topics_realized).toBe(3);
    expect(coverage.diagnostics.topics).toHaveLength(3);
    expect(coverage.turns.map((t) => t.turn_id)).toEqual(["t1", "t2", "t3"]);
  });

  test("coverage is deterministic across repeated calls", () => {
    importLineageThread();
    const first = coverageSessionRecall(vault, { sessionId: "child-seg", charBudget: 100_000 });
    const second = coverageSessionRecall(vault, { sessionId: "child-seg", charBudget: 100_000 });
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });
});

describe("mined-key facets", () => {
  function importMinedThread(): void {
    importSessionRecall(vault, {
      sessionId: "mined-seg",
      turns: [
        turn("t1", "user", "call `SessionStore` for the receipts flow", 1),
        turn("t2", "assistant", "SessionStore keeps the receipt ledger", 2),
        turn("t3", "user", "unrelated turn about weather", 3),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-03T09:00:00.000Z",
    });
    // The mined-mention ledger row the session miner would have written
    // for t1 (one record per family/key/session).
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-07-03T09:00:01.000Z",
      sourceRefs: [{ id: "mined-seg:t1:symbol:SessionStore" }],
      payload: { family: "symbol", key: "SessionStore", session_ref: "mined-seg", turn_id: "t1" },
    });
  }

  test("mined keys join the fan-out and match every turn that carries them", () => {
    importMinedThread();
    const coverage = coverageSessionRecall(vault, { sessionId: "mined-seg", charBudget: 100_000 });
    const mined = coverage.diagnostics.topics.find((topic) => topic.origin === "mined");
    expect(mined).toMatchObject({ key: "mined:symbol:SessionStore", turn_count: 1 });
    // The wide pass matches every in-scope turn carrying the key, not
    // only the establishing turn: t2 mentions it too and is returned.
    expect(coverage.turns.map((t) => t.turn_id)).toEqual(["t1", "t2", "t3"]);
  });

  test("a mention scoped outside the requested session contributes no facet", () => {
    importMinedThread();
    const coverage = coverageSessionRecall(vault, {
      sessionId: "other-seg",
      charBudget: 100_000,
    });
    expect(coverage.diagnostics.topics.filter((topic) => topic.origin === "mined")).toEqual([]);
  });
});

describe("entity-thread wiring", () => {
  function importTwoSessions(): void {
    importSessionRecall(vault, {
      sessionId: "seg-a",
      turns: [
        turn("a1", "user", "call `SessionStore` for the receipts flow", 1),
        turn("a2", "assistant", "SessionStore keeps the receipt ledger", 2),
        turn("a3", "user", "unrelated turn about weather", 3),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-03T09:00:00.000Z",
    });
    importSessionRecall(vault, {
      sessionId: "seg-b",
      turns: [
        turn("b1", "user", "migrate `SessionStore` behind the flag", 31),
        turn("b2", "assistant", "done; SessionStore is feature-flagged", 32),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-03T09:02:00.000Z",
    });
  }

  /** One mined-mention ledger row, the shape `mineAndRecordTurn` writes. */
  function mention(sessionRef: string, turnId: string, key = "SessionStore"): void {
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-07-03T09:00:01.000Z",
      sourceRefs: [{ id: `${sessionRef}:${turnId}:symbol:${key}` }],
      payload: { family: "symbol", key, session_ref: sessionRef, turn_id: turnId },
    });
  }

  test("a coverage call seeded by an entity key returns the turns that establish it, chronologically", () => {
    importTwoSessions();
    mention("seg-a", "a1");
    mention("seg-b", "b1");

    const coverage = coverageSessionRecall(vault, {
      entityKey: "SessionStore",
      charBudget: 1_000_000,
    });

    const ids = coverage.turns.map((t) => t.turn_id);
    // The establishing turns of BOTH mentioned sessions are in the
    // selection, in `compareRecords` chronological order across them.
    expect(ids).toContain("a1");
    expect(ids).toContain("b1");
    expect(ids.indexOf("a1")).toBeLessThan(ids.indexOf("b1"));
    // The seeded key leads the fan-out, so the topic budget can never
    // cut the facet the call was seeded for.
    expect(coverage.diagnostics.topics[0]).toMatchObject({
      key: "mined:symbol:SessionStore",
      origin: "mined",
    });
    // The scope is the mentioned sessions' record set, so the diagnostics
    // stay recomputable from it.
    expect(coverage.diagnostics.facets_detected).toBeGreaterThan(0);
    expect(coverage.diagnostics.topics_requested).toBeGreaterThanOrEqual(
      coverage.diagnostics.topics_realized,
    );
  });

  test("an unknown entity key raises the typed error, never an empty silent result", () => {
    importTwoSessions();
    let probe: SessionCoverageEntityUnknownError | null = null;
    try {
      coverageSessionRecall(vault, { entityKey: "NoSuchKey", charBudget: 100_000 });
    } catch (err) {
      probe = err as SessionCoverageEntityUnknownError;
    }
    expect(probe).not.toBeNull();
    expect(probe).toBeInstanceOf(SessionCoverageEntityUnknownError);
    expect(probe!.name).toBe("SessionCoverageEntityUnknownError");
    expect(probe!.entityKey).toBe("NoSuchKey");
    expect(probe!.reason).toBe("no_mention_rows");
    expect(probe!.message).toContain("NoSuchKey");
  });

  test("a key whose establishing turns the recall DAG never imported raises the same family", () => {
    importTwoSessions();
    mention("seg-never-imported", "x1");
    let probe: SessionCoverageEntityUnknownError | null = null;
    try {
      coverageSessionRecall(vault, { entityKey: "SessionStore", charBudget: 100_000 });
    } catch (err) {
      probe = err as SessionCoverageEntityUnknownError;
    }
    expect(probe).not.toBeNull();
    expect(probe!.reason).toBe("no_imported_turns");
    expect(probe!.mentionRows).toBe(1);
    expect(probe!.message).toContain("SessionStore");
  });

  test("a seed that names turns outside the requested session scope raises, not silently widens", () => {
    importTwoSessions();
    mention("seg-a", "a1");
    expect(() =>
      coverageSessionRecall(vault, {
        entityKey: "SessionStore",
        sessionId: "seg-b",
        charBudget: 100_000,
      }),
    ).toThrow(SessionCoverageEntityUnknownError);
  });

  test("at remote reach both seed refusals share one message: withheld existence is withheld", () => {
    importTwoSessions();
    // A key whose ONLY establishing turn is a private row: the mention row
    // exists and is not itself private, the turn is withheld at remote
    // reach - the exact case where the old pair of distinct refusal
    // messages told a remote caller that rows exist for a withheld key.
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-07-09T09:00:00.000Z",
      sourceRefs: [],
      private: true,
      payload: {
        session_id: "seg-a",
        turn_id: "p1",
        timestamp: "2026-07-03T09:00:30.000Z",
        role: "user",
        text: "SecretKey gossip inside a private region",
      },
    });
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-07-09T09:00:01.000Z",
      sourceRefs: [{ id: "seg-a:p1:symbol:SecretKey" }],
      payload: { family: "symbol", key: "SecretKey", session_ref: "seg-a", turn_id: "p1" },
    });

    const refusalOf = (entityKey: string): string => {
      try {
        coverageSessionRecall(vault, { entityKey, charBudget: 100_000, withholdPrivate: true });
      } catch (err) {
        return (err as SessionCoverageEntityUnknownError).message;
      }
      return "";
    };
    // Both withheld refusals answer with the no-rows wording: whether
    // mention rows exist for a withheld key is itself withheld.
    expect(refusalOf("SecretKey")).toBe(
      "session recall coverage: no session_entity_mention row names the entity key SecretKey",
    );
    expect(refusalOf("SecretKey")).not.toContain("mention row(s)");
    // The local caller keeps the distinguishing diagnostics.
    expect(() =>
      coverageSessionRecall(vault, { entityKey: "NoSuchKey", charBudget: 100_000 }),
    ).toThrow(/no session_entity_mention row names/);
    // And locally the private turn still establishes its key.
    const local = coverageSessionRecall(vault, { entityKey: "SecretKey", charBudget: 100_000 });
    expect(local.turns.map((t) => t.turn_id)).toContain("p1");
  });

  test("a multi-session seed selects in chronological order, not mention-row order", () => {
    importTwoSessions();
    // The ledger holds seg-b's row first: the deduplicated scope must not
    // inherit that order, or facet order - and therefore which facets
    // survive the topic budget - follows mention-row order.
    mention("seg-b", "b1");
    mention("seg-a", "a1");

    const coverage = coverageSessionRecall(vault, {
      entityKey: "SessionStore",
      charBudget: 1_000_000,
    });
    // The mined seed still leads the fan-out; the CLUSTER facets follow in
    // scope order: the chronologically earlier session's first cluster
    // first, whatever order the mention rows hold.
    expect(coverage.diagnostics.topics[0]!.origin).toBe("mined");
    const aNode = listContinuityRecords(vault)
      .filter(
        (record) =>
          record.kind === "session_summary_node" &&
          record.payload["depth"] === 1 &&
          record.payload["session_id"] === "seg-a" &&
          Array.isArray(record.payload["source_record_ids"]) &&
          (record.payload["source_record_ids"] as unknown[]).length === 2,
      )
      .map((record) => record.id)[0]!;
    const clusterKeys = coverage.diagnostics.topics
      .map((topic) => topic.key)
      .filter((key) => key.startsWith("cluster:"));
    expect(clusterKeys[0]).toBe(`cluster:${aNode}`);
  });
});

describe("session-qualified turn identity in the coverage path", () => {
  function importIdenticalIdSessions(): void {
    // Two independent sessions whose transcripts reuse the SAME turn ids:
    // SessionTurn.turnId can repeat across sessions, so a bare turn_id is
    // not a turn identity wherever a multi-session scope can mix them.
    importSessionRecall(vault, {
      sessionId: "dup-a",
      turns: [
        turn("t1", "user", "call `SessionStore` in session A", 1),
        turn("t2", "assistant", "receipt ledger notes in session A", 2),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-06T09:00:00.000Z",
    });
    importSessionRecall(vault, {
      sessionId: "dup-b",
      turns: [
        turn("t1", "user", "the migration plan lands in session B", 61),
        turn("t2", "assistant", "more migration detail in session B", 62),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-06T09:01:00.000Z",
    });
  }

  /** One mined-mention ledger row, the shape `mineAndRecordTurn` writes. */
  function mention(sessionRef: string, turnId: string): void {
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-07-06T09:02:00.000Z",
      sourceRefs: [{ id: `${sessionRef}:${turnId}:symbol:SessionStore` }],
      payload: { family: "symbol", key: "SessionStore", session_ref: sessionRef, turn_id: turnId },
    });
  }

  test("an entity seed resolves per session: a cluster of one dup-id session cannot select the other's turns", () => {
    importIdenticalIdSessions();
    mention("dup-a", "t1");
    mention("dup-b", "t1");

    const coverage = coverageSessionRecall(vault, {
      entityKey: "SessionStore",
      charBudget: 1_000_000,
    });

    // The mined facet counts one establishing turn PER SESSION: the two
    // (session, turn) pairs are two turns, not one bare id counted once.
    expect(coverage.diagnostics.topics[0]).toMatchObject({
      key: "mined:symbol:SessionStore",
      origin: "mined",
      turn_count: 2,
    });
    // dup-b's turns carry none of the mined needle text, so only its own
    // cluster facet can surface them: the cluster of dup-b must resolve
    // to dup-b's turns, never to the same-named turns of dup-a.
    const texts = coverage.turns.map((t) => t.text);
    expect(texts.some((text) => text.includes("in session B"))).toBe(true);
    expect(texts.some((text) => text.includes("in session A"))).toBe(true);
  });

  test("a mention naming only session A's turn does not satisfy a B-scoped seed", () => {
    importIdenticalIdSessions();
    mention("dup-a", "t1");
    let probe: SessionCoverageEntityUnknownError | null = null;
    try {
      coverageSessionRecall(vault, {
        entityKey: "SessionStore",
        sessionId: "dup-b",
        charBudget: 100_000,
      });
    } catch (err) {
      probe = err as SessionCoverageEntityUnknownError;
    }
    // dup-b imports turns named t1/t2 too, but the seed's establishing
    // turn is (dup-a, t1): the bare-id match must not stand in for it.
    expect(probe).not.toBeNull();
    expect(probe).toBeInstanceOf(SessionCoverageEntityUnknownError);
    expect(probe!.reason).toBe("no_imported_turns");
    expect(probe!.mentionRows).toBe(1);
  });
});

describe("typed floor-violation infeasibility", () => {
  test("a budget below the floor-weighted selection raises the typed error, named fields", () => {
    importLineageThread();
    let probe: SessionCoverageInfeasibleError | null = null;
    try {
      coverageSessionRecall(vault, { sessionId: "child-seg", charBudget: 1 });
    } catch (err) {
      probe = err as SessionCoverageInfeasibleError;
    }
    expect(probe).not.toBeNull();
    expect(probe).toBeInstanceOf(SessionCoverageInfeasibleError);
    expect(probe!.name).toBe("SessionCoverageInfeasibleError");
    expect(probe!.topicFloor).toBe(12);
    // Four realized topics; the floor target is all four (min(4, 12)).
    expect(probe!.requestedTopics).toBe(4);
    expect(probe!.keptTopics).toBe(0);
    expect(probe!.requiredChars).toBeGreaterThan(1);
    // The message names requested topics, kept topics and required chars.
    expect(probe!.message).toContain(`required chars ${probe!.requiredChars}`);
    expect(probe!.message).toContain(`kept topics ${probe!.keptTopics}`);
    expect(probe!.message).toContain(`requested topics ${probe!.requestedTopics}`);
  });

  test("a floor topic realizes on any kept turn, not only its top-ranked one", () => {
    // The mined key's top-ranked turn is a pasted log: the most occurrences
    // give it the highest score AND the largest body, so the greedy budget
    // skips it. The topic's small second mention fits - and that is enough
    // to realize the topic. The guard used to demand the TOP-ranked turn
    // and refused a budget the real selection satisfied.
    const logText = `${"SessionStore pinged ".repeat(60)}end of pasted log`;
    importSessionRecall(vault, {
      sessionId: "mined-crowd-seg",
      turns: [
        turn("t1", "user", logText, 1),
        turn("t2", "assistant", "SessionStore noted", 2),
        turn("t3", "user", "unrelated weather chat", 3),
        turn("t4", "assistant", "more unrelated chat", 4),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-07T09:00:00.000Z",
    });
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-07-07T09:00:01.000Z",
      sourceRefs: [{ id: "mined-crowd-seg:t1:symbol:SessionStore" }],
      payload: {
        family: "symbol",
        key: "SessionStore",
        session_ref: "mined-crowd-seg",
        turn_id: "t1",
      },
    });
    const serialized = listSessionRawTurns(vault, "mined-crowd-seg").map((t) => JSON.stringify(t));
    // The log outranks everything (2 + occurrences) and dwarfs the budget;
    // the small second mention, plus the second cluster's turns, fit.
    const budget =
      [...serialized[1]!].length + [...serialized[2]!].length + [...serialized[3]!].length;
    expect([...serialized[0]!].length).toBeGreaterThan(budget);

    const coverage = coverageSessionRecall(vault, {
      sessionId: "mined-crowd-seg",
      charBudget: budget,
    });
    // Every floor topic keeps evidence; the skipped log is named in the
    // diagnostics, never a refusal.
    expect(coverage.turns.map((t) => t.turn_id)).toEqual(["t2", "t3", "t4"]);
    expect(coverage.diagnostics.dropped_turn_ids).toEqual(["t1"]);
    expect(coverage.diagnostics.topics_realized).toBe(3);
  });

  test("a floor topic with no budget for any of its turns still raises, priced per cheapest turn", () => {
    // Two depth-1 clusters: {t1, t2} serialized long, {t3, t4} short. The
    // selection is rank-ordered, so the long cluster's turns can spend the
    // whole budget before the short cluster's first turn is reached - and
    // the short floor topic keeps zero evidence. The typed error stays for
    // that genuinely impossible budget; requiredChars prices the cheapest
    // turn per floor topic, the honest retry bound.
    const longText = "x".repeat(2400);
    importSessionRecall(vault, {
      sessionId: "crowd-seg",
      turns: [
        turn("t1", "user", longText, 1),
        turn("t2", "assistant", longText, 2),
        turn("t3", "user", "short floor-topic evidence", 3),
        turn("t4", "assistant", "more short floor-topic evidence", 4),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-04T09:00:00.000Z",
    });
    const serialized = listSessionRawTurns(vault, "crowd-seg").map((t) => JSON.stringify(t));
    // The budget holds the long cluster's turns exactly plus one char:
    // the greedy rank-order pass keeps t1 and t2 and drops t3 and t4.
    const budget = serialized[0]!.length + serialized[1]!.length + 1;

    let probe: SessionCoverageInfeasibleError | null = null;
    try {
      coverageSessionRecall(vault, { sessionId: "crowd-seg", charBudget: budget });
    } catch (err) {
      probe = err as SessionCoverageInfeasibleError;
    }
    expect(probe).not.toBeNull();
    expect(probe).toBeInstanceOf(SessionCoverageInfeasibleError);
    // requiredChars prices the cheapest turn per floor topic: one long
    // turn for the first cluster, t3 for the short one.
    expect(probe!.requiredChars).toBe([...serialized[0]!].length + [...serialized[2]!].length);
    expect(probe!.charBudget).toBe(budget);
    // The bound is honest: at it the greedy pass keeps one turn per topic
    // and the turns ranked behind them are still dropped, visibly.
    const at = coverageSessionRecall(vault, {
      sessionId: "crowd-seg",
      charBudget: probe!.requiredChars,
    });
    expect(at.turns.map((t) => t.turn_id)).toEqual(["t1", "t3"]);
    expect(at.diagnostics.dropped_turn_ids).toEqual(["t2", "t4"]);
  });

  test("astral-plane turns spend code points: a feasible budget is never falsely refused", () => {
    // Two depth-1 clusters, the long one emoji-heavy: UTF-16 length counts
    // each astral character twice, while the real selection
    // (`applyCharBudget`) spends code points. A budget sized to the
    // code-point requirement through the deepest floor-top rank is
    // feasible by construction, so the floor guard must accept it - the
    // UTF-16 rank-prefix arithmetic refuses the very same budget.
    const emojiText = "\u{1F600}".repeat(200); // 400 UTF-16 units, 200 code points, still inline
    importSessionRecall(vault, {
      sessionId: "astral-seg",
      turns: [
        turn("t1", "user", emojiText, 1),
        turn("t2", "assistant", emojiText, 2),
        turn("t3", "user", "short floor-topic evidence", 3),
        turn("t4", "assistant", "more short floor-topic evidence", 4),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-05T09:00:00.000Z",
    });
    const serialized = listSessionRawTurns(vault, "astral-seg").map((t) => JSON.stringify(t));
    const utf16Requirement = serialized[0]!.length + serialized[1]!.length + serialized[2]!.length;
    const codePointRequirement =
      [...serialized[0]!].length + [...serialized[1]!].length + [...serialized[2]!].length;
    // The UTF-16 arithmetic exceeds the budget the real selection needs.
    expect(utf16Requirement).toBeGreaterThan(codePointRequirement);

    const coverage = coverageSessionRecall(vault, {
      sessionId: "astral-seg",
      charBudget: codePointRequirement,
    });
    // Every floor topic keeps its top turn; only the turn ranked behind
    // the floor is dropped, visibly.
    expect(coverage.turns.map((t) => t.turn_id)).toEqual(["t1", "t2", "t3"]);
    expect(coverage.diagnostics.chars_used).toBe(codePointRequirement);
    expect(coverage.diagnostics.dropped_turn_ids).toEqual(["t4"]);
  });

  test("requiredChars speaks the spender's unit: astral turns are priced in code points", () => {
    // The infeasibility diagnostics must price the rank-ordered selection
    // the way applyCharBudget spends it - code points, not UTF-16 units -
    // or the retry bound it reports is not the honest one for astral
    // content: the UTF-16 arithmetic overcounts every astral character
    // twice and reports a bound above the real requirement.
    const emojiText = "\u{1F600}".repeat(200); // 400 UTF-16 units, 200 code points
    importSessionRecall(vault, {
      sessionId: "astral-floor-seg",
      turns: [
        turn("t1", "user", emojiText, 1),
        turn("t2", "assistant", emojiText, 2),
        turn("t3", "user", "short floor-topic evidence", 3),
        turn("t4", "assistant", "more short floor-topic evidence", 4),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-05T10:00:00.000Z",
    });
    const serialized = listSessionRawTurns(vault, "astral-floor-seg").map((t) => JSON.stringify(t));
    const utf16Requirement = serialized[0]!.length + serialized[1]!.length + serialized[2]!.length;
    const codePointRequirement =
      [...serialized[0]!].length + [...serialized[1]!].length + [...serialized[2]!].length;
    expect(utf16Requirement).toBeGreaterThan(codePointRequirement);

    let probe: SessionCoverageInfeasibleError | null = null;
    try {
      coverageSessionRecall(vault, { sessionId: "astral-floor-seg", charBudget: 1 });
    } catch (err) {
      probe = err as SessionCoverageInfeasibleError;
    }
    expect(probe).toBeInstanceOf(SessionCoverageInfeasibleError);
    // Cheapest turn per floor topic, priced in code points: one astral
    // turn for the first cluster, the short t3 for the second.
    expect(probe!.requiredChars).toBe([...serialized[0]!].length + [...serialized[2]!].length);
    // The bound stays exact: at it the floor holds, one below it fails.
    const at = coverageSessionRecall(vault, {
      sessionId: "astral-floor-seg",
      charBudget: probe!.requiredChars,
    });
    expect(at.turns.map((t) => t.turn_id)).toEqual(["t1", "t3"]);
    expect(() =>
      coverageSessionRecall(vault, {
        sessionId: "astral-floor-seg",
        charBudget: probe!.requiredChars - 1,
      }),
    ).toThrow(SessionCoverageInfeasibleError);
  });

  test("requiredChars is the exact retry bound: at it, no error; one below, the error", () => {
    // Groups of one: every turn is its own floor topic, so the floor's
    // honest requirement - the cheapest turn of every topic - is the whole
    // thread, and the rank-ordered selection realizes it exactly at the
    // bound and drops the last topic one character below it.
    importSessionRecall(vault, {
      sessionId: "bound-seg",
      turns: [
        turn("t1", "user", "alpha topic evidence", 1),
        turn("t2", "assistant", "beta topic evidence", 2),
        turn("t3", "user", "gamma topic evidence", 3),
        turn("t4", "assistant", "delta topic evidence", 4),
      ],
      summaryGroupSize: 1,
      createdAt: "2026-07-08T09:00:00.000Z",
    });
    let requiredChars: number;
    try {
      coverageSessionRecall(vault, { sessionId: "bound-seg", charBudget: 1 });
      throw new Error("expected the typed infeasibility error");
    } catch (err) {
      requiredChars = (err as SessionCoverageInfeasibleError).requiredChars;
    }
    const at = coverageSessionRecall(vault, {
      sessionId: "bound-seg",
      charBudget: requiredChars,
    });
    // At the requirement every floor topic is represented.
    expect(at.diagnostics.topics_realized).toBe(4);
    expect(at.diagnostics.chars_used).toBeLessThanOrEqual(requiredChars);
    expect(() =>
      coverageSessionRecall(vault, { sessionId: "bound-seg", charBudget: requiredChars - 1 }),
    ).toThrow(SessionCoverageInfeasibleError);
  });

  test("above the floor, drops land in diagnostics and never throw", () => {
    // The long-cluster/short-cluster thread: the floor's honest
    // requirement is one cheapest turn per topic, so a little above it
    // the remaining turns are dropped, visibly - every dropped turn is
    // named, and kept plus dropped still accounts for the whole thread.
    const longText = "x".repeat(2400);
    importSessionRecall(vault, {
      sessionId: "drops-seg",
      turns: [
        turn("t1", "user", longText, 1),
        turn("t2", "assistant", longText, 2),
        turn("t3", "user", "short floor-topic evidence", 3),
        turn("t4", "assistant", "more short floor-topic evidence", 4),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-04T10:00:00.000Z",
    });
    let requiredChars: number;
    try {
      coverageSessionRecall(vault, { sessionId: "drops-seg", charBudget: 1 });
      throw new Error("expected the typed infeasibility error");
    } catch (err) {
      requiredChars = (err as SessionCoverageInfeasibleError).requiredChars;
    }
    const coverage = coverageSessionRecall(vault, {
      sessionId: "drops-seg",
      charBudget: requiredChars + 10,
    });
    expect(coverage.turns.length).toBeGreaterThan(0);
    expect(coverage.diagnostics.dropped_turn_ids.length).toBeGreaterThan(0);
    expect(coverage.turns.length + coverage.diagnostics.dropped_turn_ids.length).toBe(4);
    expect(coverage.diagnostics.chars_used).toBeLessThanOrEqual(requiredChars + 10);
    expect(coverage.diagnostics.topics_realized).toBe(2);
  });
});

describe("omitted-operation byte-identity (grep unchanged)", () => {
  function seedFrozen(): void {
    importSessionRecall(vault, {
      sessionId: "session-frozen",
      turns: [
        turn("t1", "user", "Find continuity receipt details.", 1),
        turn("t2", "assistant", "Receipt summary with tests.", 2),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-01T09:00:00.000Z",
    });
  }

  test("grep output equals the frozen pre-coverage fixture", () => {
    seedFrozen();
    const result = searchSessionRecall(vault, {
      query: "receipt",
      sessionId: "session-frozen",
      limit: 4,
    });
    // Frozen fixture: the full serialized outcome of the pre-coverage
    // search path, pinned so the coverage lane's arrival cannot perturb
    // the operation it rides beside.
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      hits: [
        {
          id: "ctn_20260701090000_5fae660366cad639",
          kind: "session_summary_node",
          score: 3,
          snippet:
            "t1 user: Find continuity receipt details.\nt2 assistant: Receipt summary with tests.",
          line_start: 1,
          line_end: 1,
          depth: 1,
          source_record_ids: [
            "ctn_20260701090000_ae7c6b3f8780ed24",
            "ctn_20260701090000_e65d39ed24f732ab",
          ],
        },
        {
          id: "ctn_20260701090000_ae7c6b3f8780ed24",
          kind: "session_turn",
          score: 3,
          snippet: "Find continuity receipt details.",
          line_start: 1,
          line_end: 1,
          turn_id: "t1",
          role: "user",
        },
        {
          id: "ctn_20260701090000_e65d39ed24f732ab",
          kind: "session_turn",
          score: 3,
          snippet: "Receipt summary with tests.",
          line_start: 1,
          line_end: 1,
          turn_id: "t2",
          role: "assistant",
        },
      ],
    });
  });
});
