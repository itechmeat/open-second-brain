/**
 * The overlapped-lane join seam (recall-lane-latency): the semantic lane
 * starts before the keyword lanes run and is joined where the serial await
 * stood. The unit half runs over fake promises, so the catch-attachment
 * semantics are pinned without an HTTP round trip: the lane starts at
 * seam-creation time (the keyword step's window), a keyword-step throw
 * never strands an in-flight lane as an unhandled rejection, and a clock
 * that already ran out starts nothing. The integration half runs search()
 * against the fake embed endpoint and pins the overlapped contract: the
 * same rows as the serial pipeline produced, the embed in flight across
 * the join, keyword sentences before semantic sentences - and the one
 * property the lane exists for, that the embed request actually DISPATCHES
 * before the keyword lanes finish (a semaphore acquire that yields a
 * microtask on the free-permit path would ship the dispatch after them,
 * and the ordering test below is the pin that catches it).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  createCompositeDeadline,
  overlappedEmbedMs,
  search,
  startSemanticLane,
} from "../../../src/core/search/search.ts";
import type { SearchLaneTiming } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import type { RetrievalDegradationSink } from "../../../src/core/search/retrieval-trail.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

/**
 * A real composite deadline with a controlled clock: `expiresAt` is what
 * the seam reads, so the budget is anchored backwards from it.
 */
function realDeadline(expiresAt: number): {
  readonly deadline: NonNullable<ReturnType<typeof createCompositeDeadline>>;
  readonly warnings: string[];
} {
  const warnings: string[] = [];
  const budgetMs = 60_000;
  const deadline = createCompositeDeadline({
    budgetMs,
    startMs: expiresAt - budgetMs,
    clock: () => Date.now(),
    warnings,
    degraded: [],
    wantSemantic: true,
    keywordHitCount: () => 1,
  });
  if (deadline === null) throw new Error("a named budget must build a deadline");
  return { deadline, warnings };
}

test("the lane starts when the seam is created, so the keyword step runs while it is pending", async () => {
  const gate = Promise.withResolvers<string>();
  let settled = false;
  const lane = startSemanticLane({
    start: () =>
      gate.promise.then((value) => {
        settled = true;
        return value;
      }),
    deadline: null,
    fallback: () => {
      throw new Error("the fallback must never run for a joined lane");
    },
  });
  // The caller's synchronous keyword step runs HERE, between start and
  // join, while the lane promise is still in flight.
  expect(settled).toBe(false);
  gate.resolve("lane outcome");
  expect(await lane.join()).toBe("lane outcome");
});

test("a keyword-step throw with a deadline routes the lane's rejection to the abandoned-failure note", async () => {
  const gate = Promise.withResolvers<string>();
  const { deadline, warnings } = realDeadline(Date.now() + 60_000);
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  // The keyword step throws and the call unwinds without ever joining;
  // the in-flight lane rejects afterwards.
  const keywordStep = (): never => {
    throw new Error("keyword lane exploded");
  };
  expect(() => keywordStep()).toThrow("keyword lane exploded");
  // The joiner exists even though this caller never reaches its join.
  expect(typeof lane.join).toBe("function");
  gate.reject(new Error("embed exploded"));
  await Bun.sleep(10);
  expect(
    warnings.some((w) =>
      w.startsWith(
        "hybrid deadline: an abandoned lane failed after the answer: Error: embed exploded",
      ),
    ),
  ).toBe(true);
});

test("a keyword-step throw with no deadline leaves no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = Promise.withResolvers<string>();
    const lane = startSemanticLane({
      start: () => gate.promise,
      deadline: null,
      fallback: () => "fallback",
    });
    const keywordStep = (): never => {
      throw new Error("keyword lane exploded");
    };
    expect(() => keywordStep()).toThrow("keyword lane exploded");
    // The joiner exists even though this caller never reaches its join.
    expect(typeof lane.join).toBe("function");
    gate.reject(new Error("embed exploded"));
    await Bun.sleep(20);
    // Nobody joined; the seam owns the stranded lane and its rejection.
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an already-expired deadline starts nothing and fires at the join, after the keyword lanes", async () => {
  let started = false;
  const { deadline, warnings } = realDeadline(Date.now() - 1);
  const lane = startSemanticLane({
    start: () => {
      started = true;
      return Promise.resolve("lane");
    },
    deadline,
    fallback: () => "fallback",
  });
  expect(started).toBe(false);
  // The fire waits for the join: at the start site the keyword lanes have
  // not run, so no degrade decision exists yet.
  expect(warnings).toEqual([]);
  expect(await lane.join()).toBe("fallback");
  expect(warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
});

test("a join-time fire reads the keyword pool the lanes populated, not the empty initializer", async () => {
  const pool: number[] = [];
  const warnings: string[] = [];
  const degraded: RetrievalDegradationSink = [];
  const budgetMs = 60_000;
  const deadline = createCompositeDeadline({
    budgetMs,
    startMs: Date.now() - budgetMs - 1,
    clock: () => Date.now(),
    warnings,
    degraded,
    wantSemantic: true,
    keywordHitCount: () => pool.length,
  });
  if (deadline === null) throw new Error("a named budget must build a deadline");
  const lane = startSemanticLane({
    start: () => Promise.resolve("lane"),
    deadline,
    fallback: () => "fallback",
  });
  // The synchronous keyword lanes run here and populate the pool, exactly
  // as the serial pipeline's snapshot point assumed.
  pool.push(2);
  expect(await lane.join()).toBe("fallback");
  expect(warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
  // The umbrella fires: the degrade decision saw the real pool, not the
  // empty initializer a start-site fire would have read.
  expect(warnings).toContain("hybrid_degraded: semantic lane unavailable, served keyword-only");
});

test("a lane that fails after a join-time fire is named, not defused", async () => {
  const gate = Promise.withResolvers<string>();
  const warnings: string[] = [];
  const degraded: RetrievalDegradationSink = [];
  let now = Date.now();
  const deadline = createCompositeDeadline({
    budgetMs: 60_000,
    startMs: now - 30_000,
    clock: () => now,
    warnings,
    degraded,
    wantSemantic: true,
    keywordHitCount: () => 1,
  });
  if (deadline === null) throw new Error("a named budget must build a deadline");
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  // The clock expires while the keyword lanes run, before the join: the
  // join's never-start arm fires the deadline and serves the fallback.
  now += 31_000;
  expect(await lane.join()).toBe("fallback");
  expect(deadline.hasFired()).toBe(true);
  // The lane then rejects with a non-abort failure. The race never armed,
  // so the at-start handler is still the deadline's ear for this lane.
  gate.reject(new Error("embed exploded after the join-time fire"));
  await Bun.sleep(20);
  expect(
    warnings.some((w) =>
      w.startsWith(
        "hybrid deadline: an abandoned lane failed after the answer: Error: embed exploded after the join-time fire",
      ),
    ),
  ).toBe(true);
});

test("a joined lane that loses the race serves the fallback and names a late failure", async () => {
  const gate = Promise.withResolvers<string>();
  const { deadline, warnings } = realDeadline(Date.now() + 25);
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  expect(await lane.join()).toBe("fallback");
  expect(warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
  gate.reject(new Error("late embed failure"));
  await Bun.sleep(20);
  expect(
    warnings.some((w) =>
      w.startsWith(
        "hybrid deadline: an abandoned lane failed after the answer: Error: late embed failure",
      ),
    ),
  ).toBe(true);
});

test("the overlap arithmetic is the exact intersection of the two intervals", () => {
  // The embed starts with the seam and the keyword lane runs wholly
  // underneath it: the overlap is the keyword interval, byte for byte.
  expect(overlappedEmbedMs(1_000, 1_500, 1_010, 1_090)).toBe(80);
  // The keyword lane outlasts the embed: the embed tail is what hid.
  expect(overlappedEmbedMs(1_000, 1_050, 1_020, 1_200)).toBe(30);
  // Disjoint intervals never invent overlap, in either order.
  expect(overlappedEmbedMs(1_000, 1_050, 1_100, 1_200)).toBe(0);
  expect(overlappedEmbedMs(1_100, 1_200, 1_000, 1_050)).toBe(0);
  // Identical stamps (a sub-millisecond lane on a coarse clock) are zero,
  // never negative.
  expect(overlappedEmbedMs(1_000, 1_000, 1_000, 1_000)).toBe(0);
  // A stamp pair that crosses (end before start) floors at zero.
  expect(overlappedEmbedMs(1_050, 1_000, 1_000, 1_200)).toBe(0);
});

test("a lane that rejects before the fire rethrows through the join", async () => {
  const gate = Promise.withResolvers<string>();
  const { deadline } = realDeadline(Date.now() + 60_000);
  const lane = startSemanticLane({
    start: () => gate.promise,
    deadline,
    fallback: () => "fallback",
  });
  gate.reject(new Error("embed refused"));
  const note = await lane.join().then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );
  expect(note).toBe("embed refused");
});

// ── search() over a real index ───────────────────────────────────────────────

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("hybrid-overlap");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
}, 20_000);

afterEach(async () => {
  cleanup();
  await server.close();
}, 20_000);

function semanticConfig(extra: Record<string, unknown> = {}) {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 2,
      batchSize: 8,
      costGateUsd: 0,
      maxRetries: 1,
      ...extra,
    },
  });
}

async function seedCorpus() {
  writeMd(vault, "Notes/fox.md", "# Fox\n\nThe quick brown fox jumps over the lazy dog.");
  writeMd(vault, "Other/bar.md", "# Bar\n\nA different note about cats and turtles.");
}

/** Embeddings-shaped body with the default handler's deterministic vectors. */
function embeddingsBody(req: { body: unknown }) {
  const body = (req.body ?? {}) as { input?: string[]; model?: string };
  const inputs = Array.isArray(body.input) ? body.input : [];
  return {
    status: 200,
    body: {
      data: inputs.map((text, index) => {
        const tokens = text.split(/\s+/).filter(Boolean).length;
        return { object: "embedding", embedding: [tokens, index, text.length, 1], index };
      }),
      model: body.model ?? "fake-model",
    },
  };
}

/** The stable projection the deadline suite pins: rows, order, typing. */
function resultShape(out: Awaited<ReturnType<typeof search>>): ReadonlyArray<unknown> {
  return out.results.map((r) => [r.path, r.searchType, r.score > 0, r.reasons]);
}

test("a delayed embed joined under both deadline arms keeps one result shape", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const cfg = semanticConfig();
  await indexVault(cfg, { embeddings: true });
  // A slow round trip makes the join actually wait; both deadline arms
  // must serve the same rows the serial pipeline produced.
  server.setHandler((req) => ({ ...embeddingsBody(req), delayMs: 150 }));

  const withClock = await search(cfg, { query: "fox", limit: 5, semantic: true });
  const clockOff = await search(
    { ...cfg, hybridDeadlineMs: 0 },
    {
      query: "fox",
      limit: 5,
      semantic: true,
    },
  );
  expect(resultShape(withClock)).toEqual(resultShape(clockOff));
  // The join delivered the lane's hits into the fused ranking.
  expect(withClock.results.some((r) => r.searchType === "hybrid")).toBe(true);
});

test("the embed request is in flight across the join while the answer is pending", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const cfg = semanticConfig();
  await indexVault(cfg, { embeddings: true });
  const arrived = Promise.withResolvers<void>();
  server.setHandler((req) => {
    if (req.path.endsWith("/embeddings")) arrived.resolve();
    return { ...embeddingsBody(req), delayMs: 200 };
  });

  let resolved = false;
  const started = Date.now();
  const pending = search(cfg, { query: "fox", limit: 5, semantic: true }).then((out) => {
    resolved = true;
    return out;
  });
  await arrived.promise;
  // The round trip was put in flight and has not answered: the answer
  // cannot be served ahead of the lane it joined.
  expect(resolved).toBe(false);
  const out = await pending;
  // Generous bounds, robust to timer clamping: the answer waited out the
  // embed delay it joined rather than cutting the lane short.
  expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  expect(out.results.some((r) => r.searchType === "hybrid")).toBe(true);
});

test("the embed request dispatches before the keyword lanes finish", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const cfg = semanticConfig();
  await indexVault(cfg, { embeddings: true });

  // The ordering is read as EVENT order at two synchronous seams, not as
  // wall-clock arithmetic: a millisecond-resolution clock stamps a
  // dispatch and a keyword lane that share a tick with the same reading,
  // so a timestamp comparison flakes on exactly the runs it exists to
  // catch. The fetch seam records the embed dispatch; the keyword lane's
  // bm25 read records the keyword lanes' execution - the one
  // `bm25(chunk_fts` query in the store, so the query-shape step's
  // document-frequency reads (a COUNT, no bm25) never log a false marker.
  const events: string[] = [];
  let dispatchMs: number | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/embeddings") && !events.includes("dispatch")) {
      events.push("dispatch");
      dispatchMs = Date.now();
    }
    return realFetch(...args);
  }) as typeof fetch;
  const realQuery = Database.prototype.query;
  Database.prototype.query = function (this: Database, sql: string): unknown {
    if (sql.includes("bm25(chunk_fts")) events.push("keyword-fts");
    return (realQuery as unknown as (this: Database, sql: string) => unknown).call(this, sql);
  } as typeof Database.prototype.query;

  // The fake server shares this process's event loop, so its handler can
  // only observe the request once the synchronous keyword work yields -
  // arrival at the handler can never precede the keyword stamps. The
  // dispatch at the fetch seam is the ordering observable; the arrival
  // log pins that the observed dispatch reached the endpoint.
  const arrivals: number[] = [];
  server.setHandler((req) => {
    if (req.path.endsWith("/embeddings")) arrivals.push(Date.now());
    return { ...embeddingsBody(req), delayMs: 150 };
  });

  let timing: SearchLaneTiming | undefined;
  let out: Awaited<ReturnType<typeof search>>;
  try {
    out = await search(cfg, {
      query: "fox",
      limit: 5,
      semantic: true,
      laneTiming: (t) => void (timing = t),
    });
  } finally {
    Database.prototype.query = realQuery;
    globalThis.fetch = realFetch;
  }

  // Both seams were hit, and the answer joined the ranked lanes.
  expect(events).toContain("dispatch");
  expect(events).toContain("keyword-fts");
  expect(out.results.some((r) => r.searchType === "hybrid")).toBe(true);
  // The load-bearing ordering: the request left inside the lane-start
  // tick, before the keyword lanes' own read ran - the keyword lanes
  // executed while the round trip was outstanding, which is the overlap
  // the lane exists to buy. A dispatch parked on a microtask by a
  // yielding semaphore acquire lands after that read and fails here.
  expect(events.indexOf("dispatch")).toBeLessThan(events.indexOf("keyword-fts"));
  // The same ordering in the sink's stamps: the dispatch precedes the
  // keyword interval's opening and, with it, the keyword lane's end stamp.
  if (
    timing === undefined ||
    dispatchMs === undefined ||
    timing.embedStartMs === undefined ||
    timing.embedEndMs === undefined
  ) {
    throw new Error("the lane timing sink or the dispatch/resolution stamps never arrived");
  }
  expect(dispatchMs).toBeLessThanOrEqual(timing.keywordStartMs);
  expect(dispatchMs).toBeLessThanOrEqual(timing.keywordEndMs);
  // The sink's start stamp is the dispatch report: the phase stamped the
  // moment the provider handed the request toward the wire, not an
  // earlier pre-call instant, and the resolution stamp sits behind the
  // delayed answer, past the keyword lane's end.
  expect(timing.embedStartMs).toBeLessThanOrEqual(dispatchMs);
  expect(timing.embedEndMs).toBeGreaterThan(timing.keywordEndMs);
  // The delayed endpoint kept the lane's resolution behind the keyword
  // lane, so the dispatch really did precede the answer.
  expect(arrivals.length).toBeGreaterThan(0);
  expect(arrivals[0]).toBeLessThan(timing.embedEndMs ?? Number.MAX_SAFE_INTEGER);
});

test("a provider that never reports a dispatch keeps the pre-call interval as the fallback", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  // The offline local embedder never reports a dispatch, so the phase's
  // pre-call stamp is the only start it can have, and its interval is the
  // whole awaited call. Its embed finishes synchronously, but the
  // resolution stamp is written by the await's continuation, which runs
  // only once the caller's synchronous keyword lanes have yielded - so the
  // fallback interval always encloses the keyword interval, and the
  // overlap is the keyword interval's length. On the wall clock that
  // length is 0 or 1 ms depending on whether the lanes crossed a tick, so
  // the clock the request reads is stepped: every read is one millisecond
  // later than the last, which makes each stamp distinct and ordered.
  const cfg = semanticConfig({ provider: "local" });
  await indexVault(cfg, { embeddings: true });
  let timing: SearchLaneTiming | undefined;
  const realNow = Date.now;
  let tick = realNow();
  Date.now = () => (tick += 1);
  let out: Awaited<ReturnType<typeof search>>;
  try {
    out = await search(cfg, {
      query: "fox",
      limit: 5,
      semantic: true,
      laneTiming: (t) => void (timing = t),
    });
  } finally {
    Date.now = realNow;
  }
  if (
    timing === undefined ||
    timing.embedStartMs === undefined ||
    timing.embedEndMs === undefined
  ) {
    throw new Error("the lane timing sink or its fallback interval never arrived");
  }
  // The start is the pre-call stamp from the lane-start tick, before the
  // keyword lanes open; the end is the continuation past their close.
  expect(timing.embedStartMs).toBeLessThan(timing.keywordStartMs);
  expect(timing.embedEndMs).toBeGreaterThanOrEqual(timing.keywordEndMs);
  expect(timing.overlappedMs).toBe(timing.keywordEndMs - timing.keywordStartMs);
  expect(out.results.some((r) => r.searchType === "hybrid")).toBe(true);
});

test("keyword sentences precede semantic sentences in the merged warnings", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  // The window must still CARRY the corpus now that provably over-window
  // chunks are held back from embedding (the skip-and-hold contract): a
  // window of 8 held every seeded chunk, so no embedding existed and the
  // query-side cut never ran. At 32 the seeded chunks embed and the
  // 200-character query still exceeds the window, which is the cut this
  // test exists to observe.
  const cfg = semanticConfig({ inputWindowTokens: 32 });
  await indexVault(cfg, { embeddings: true });
  // Keyword sentence: a desynced FTS table rebuilt at query time.
  const db = new Database(dbPath);
  try {
    db.run("DELETE FROM chunk_fts");
  } finally {
    db.close();
  }
  // Semantic sentence: the query cut to the model's input window; the
  // embed is delayed so the lane completes after the keyword lane.
  server.setHandler((req) => ({ ...embeddingsBody(req), delayMs: 150 }));

  const out = await search(cfg, { query: "abcdefghij".repeat(20), limit: 5, semantic: true });

  const keywordSentence = out.warnings.findIndex((w) => w.includes("rebuilt FTS"));
  const semanticSentence = out.warnings.findIndex((w) =>
    w.includes("embedding_input_window_tokens"),
  );
  expect(keywordSentence).toBeGreaterThanOrEqual(0);
  expect(semanticSentence).toBeGreaterThan(keywordSentence);
});
