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
 * the join, and keyword sentences before semantic sentences.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  createCompositeDeadline,
  search,
  startSemanticLane,
} from "../../../src/core/search/search.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
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

test("an already-expired deadline starts nothing and serves the fallback", async () => {
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
  expect(warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
  expect(await lane.join()).toBe("fallback");
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

test("keyword sentences precede semantic sentences in the merged warnings", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const cfg = semanticConfig({ inputWindowTokens: 8 });
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
