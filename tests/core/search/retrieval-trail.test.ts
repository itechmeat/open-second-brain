/**
 * The retrieval trail (evidence-at-the-boundary, C2): a search result that
 * can say why it is empty.
 *
 * Two properties are asserted here, over a real vault with a fault injected
 * into SQLite rather than a stubbed lane:
 *
 *   - a degradation that used to exist only as a sentence inside
 *     `warnings[]` now also names a stable machine code on the outcome,
 *   - a zero-result answer is attributable: either a degradation named the
 *     cause, or the corpus statement did.
 *
 * The healthy non-empty path carries no trail at all, which is what keeps
 * every existing caller's bytes unchanged.
 */

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { runFtsQueryDetailed } from "../../../src/core/search/fts.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { RetrievalDegradationSink } from "../../../src/core/search/retrieval-trail.ts";
import {
  RETRIEVAL_DEGRADATION,
  RETRIEVAL_DEGRADATION_CODES,
  RETRIEVAL_DETAIL_IDENTIFIER,
  RETRIEVAL_TRAIL_KEY,
  describeRetrievalDegradation,
  isRetrievalDegradationCode,
  retrievalTrailEnvelope,
} from "../../../src/core/search/retrieval-trail.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  // Newest first: a raw connection opened on the temp index must close
  // before the directory holding it is removed (Windows refuses to delete
  // an open database file).
  for (const c of cleanups.splice(0).toReversed()) c();
});

/** A real index over two documents, built by the real indexer. */
async function indexedVault(prefix: string): Promise<{ vault: string; dbPath: string }> {
  const v = createTempVault(prefix);
  cleanups.push(v.cleanup);
  writeMd(v.vault, "a.md", "# Ops\n\nReindexing the vault can be slow on large corpora.");
  writeMd(v.vault, "b.md", "# Turtles\n\nGreen turtles migrate across oceans.");
  await indexVault(makeConfig({ vault: v.vault, dbPath: v.dbPath }), {});
  return { vault: v.vault, dbPath: v.dbPath };
}

/**
 * Leaves a `chunk_trigram` that is NOT an FTS5 shadow - the shape a
 * half-applied migration leaves behind. SQLite rejects the MATCH.
 */
function breakTrigramShadow(dbPath: string): void {
  const db = new Database(dbPath);
  cleanups.push(() => db.close(true));
  db.exec("DROP TABLE chunk_trigram");
  db.exec("CREATE TABLE chunk_trigram (id INTEGER PRIMARY KEY, fts_content TEXT)");
}

// ─── the vocabulary ──────────────────────────────────────────────────────────

test("every degradation code renders its own sentence", () => {
  const sentences = RETRIEVAL_DEGRADATION_CODES.map(describeRetrievalDegradation);
  for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0);
  expect(new Set(sentences).size).toBe(RETRIEVAL_DEGRADATION_CODES.length);
});

/** Names no rerank vendor may appear under in a trail sentence. */
const RERANK_VENDOR_NAMES = /cohere|jina|voyage|zeroentropy|zerank|mixedbread|openai/iu;

test("the rerank liveness code is kebab-case and its sentence names no provider", () => {
  expect(RETRIEVAL_DEGRADATION.rerankProviderUnavailable).toBe("rerank-provider-unavailable");
  expect(isRetrievalDegradationCode("rerank-provider-unavailable")).toBe(true);
  const sentence = describeRetrievalDegradation(RETRIEVAL_DEGRADATION.rerankProviderUnavailable);
  expect(sentence).not.toMatch(RERANK_VENDOR_NAMES);
});

test("the derived person ambiguity code narrows and its detail keys carry the form", () => {
  expect(RETRIEVAL_DEGRADATION.personDerivedAmbiguity).toBe("person-derived-ambiguity");
  expect(isRetrievalDegradationCode("person-derived-ambiguity")).toBe(true);
  const sentence = describeRetrievalDegradation(RETRIEVAL_DEGRADATION.personDerivedAmbiguity);
  expect(sentence.length).toBeGreaterThan(0);
  // The detail maps the ambiguous form (the key - a name form is not an
  // identifier) to the competing person ids dot-joined (the value - ids
  // never carry a dot, so the value stays an identifier under the rule).
  const ids = ["ent-people-richard-smith", "ent-people-robert-smith"];
  const detail = { "r smith": ids.join(".") };
  for (const value of Object.values(detail)) {
    expect(value).toMatch(RETRIEVAL_DETAIL_IDENTIFIER);
  }
});

test("the guard rejects a near miss", () => {
  expect(isRetrievalDegradationCode(RETRIEVAL_DEGRADATION.hybridDegraded)).toBe(true);
  expect(isRetrievalDegradationCode("hybrid_degraded")).toBe(false);
  expect(isRetrievalDegradationCode("")).toBe(false);
});

test("no trail means no envelope key at all", () => {
  expect(retrievalTrailEnvelope({})).toEqual({});
});

// ─── the healthy path is untouched ───────────────────────────────────────────

test("a healthy non-empty search carries no trail", async () => {
  const { vault, dbPath } = await indexedVault("trail-healthy");
  const out = await search(makeConfig({ vault, dbPath }), { query: "reindexing", limit: 10 });

  expect(out.results.length).toBeGreaterThan(0);
  expect(out.retrievalTrail).toBeUndefined();
  expect(retrievalTrailEnvelope(out)).toEqual({});
});

/**
 * The rank cap the assembler applies for any small `limit` - its pool
 * floor. Stated here because the case that matters is a corpus that ends
 * EXACTLY on it: a two-document vault can never reach the cap, so it
 * cannot tell "the cap truncated the pool" from "the pool ran out".
 */
const RANK_CAP_FLOOR = 30;
const WINDOW = 10;

/** `count` single-chunk documents, every one matching `reindexing`. */
async function vaultOfMatchingDocs(
  prefix: string,
  count: number,
): Promise<ReturnType<typeof makeConfig>> {
  const v = createTempVault(prefix);
  cleanups.push(v.cleanup);
  for (let i = 0; i < count; i++) {
    writeMd(v.vault, `doc-${i}.md`, `# Doc ${i}\n\nReindexing the vault is discussed here.`);
  }
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg, {});
  return cfg;
}

test("a corpus that ends exactly on the rank cap is not a truncated pool", async () => {
  const cfg = await vaultOfMatchingDocs("trail-cap-exact", RANK_CAP_FLOOR);

  const out = await search(cfg, { query: "reindexing", limit: WINDOW });

  // Every candidate the lanes produced was ranked; the window is narrower
  // than the pool, which is what a `limit` is for and not a narrowing.
  expect(out.results).toHaveLength(WINDOW);
  expect(out.total).toBe(RANK_CAP_FLOOR);
  expect(out.retrievalTrail).toBeUndefined();
  expect(retrievalTrailEnvelope(out)).toEqual({});
});

test("a pool the cap really did cut still names the code and the cap", async () => {
  // A wider lane pool than the cap admits: `poolMultiplier` governs how
  // many hits the keyword lane fetches, so raising it is the one knob that
  // hands the ranker more candidates than the cap can keep.
  const base = await vaultOfMatchingDocs("trail-cap-cut", RANK_CAP_FLOOR + WINDOW);
  const cfg = Object.freeze({
    ...base,
    recall: Object.freeze({ ...base.recall, poolMultiplier: 10 }),
  });

  const out = await search(cfg, { query: "reindexing", limit: WINDOW });

  const entry = out.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.rankCapTruncatedPool,
  );
  expect(entry?.detail).toEqual({ cap: RANK_CAP_FLOOR });
});

// ─── a degraded lane names its code ──────────────────────────────────────────

test("a session cap that drops rows names them beside the floor's drops", async () => {
  // Four hot notes in one source session, two weak notes in another: a
  // floor between the clusters removes the weak session, and the cap
  // bounds the crowded one - both codes ride the same trail.
  const v = createTempVault("trail-session-cap");
  cleanups.push(v.cleanup);
  for (let i = 0; i < 4; i += 1) {
    writeMd(
      v.vault,
      `a-${i}.md`,
      "---\ntitle: Hot\nsession_ref: sess-a\n---\n\n# Hot\n\n" +
        `fox fox fox fox the quick brown fox jumps over note ${i}.\n`,
    );
  }
  for (const b of ["b-0", "b-1"]) {
    writeMd(
      v.vault,
      `${b}.md`,
      "---\ntitle: Weak\nsession_ref: sess-b\n---\n\n# Weak\n\n" +
        `A note mostly about cats, with one fox mention (${b}).\n`,
    );
  }
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath, maxHops: 0, mmrLambda: 1 });
  const cappedCfg = Object.freeze({
    ...cfg,
    recall: Object.freeze({ ...cfg.recall, poolMaxPerSession: 1 }),
  });
  await indexVault(cappedCfg, {});

  // The score probe runs with the cap OFF: it measures the raw clusters
  // the floor needs, before any session bound applies.
  const unfiltered = await search(cfg, { query: "fox", limit: 10 });
  const hotScores = unfiltered.results.filter((r) => r.path.startsWith("a-")).map((r) => r.score);
  const weakScores = unfiltered.results.filter((r) => r.path.startsWith("b-")).map((r) => r.score);
  expect(hotScores.length).toBe(4);
  expect(weakScores.length).toBe(2);
  // The floor sits between the clusters: every weak note falls, every
  // hot note stays - then the cap bounds the hot session to one row.
  const floor = (Math.min(...hotScores) + Math.max(...weakScores)) / 2;

  const out = await search(cappedCfg, { query: "fox", limit: 10, threshold: floor });

  const capped = out.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.sourceSessionCappedRows,
  );
  expect(capped?.detail).toEqual({ dropped: 3, cap: 1 });
  const floored = out.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.relevanceFloorDroppedRows,
  );
  expect(floored?.detail).toEqual({ dropped: 2 });
  expect(out.results.map((r) => r.path)).toEqual(["a-0.md"]);
});

test("a trigram lane fault names its code beside the sentence it already pushed", async () => {
  const { vault, dbPath } = await indexedVault("trail-trigram");
  const cfg = makeConfig({
    vault,
    dbPath,
    trigramPrefilterEnabled: true,
    trigramPrefilterMinChunks: 0,
  });
  breakTrigramShadow(dbPath);

  const out = await search(cfg, { query: "reindexing", limit: 10 });

  // The sentence is unchanged: the trail is added beside it, not instead.
  expect(out.warnings.some((w) => w.startsWith("trigram_degraded ["))).toBe(true);
  const codes = (out.retrievalTrail?.degraded ?? []).map((d) => d.code);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.keywordTrigramLaneFault);
  const entry = out.retrievalTrail!.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.keywordTrigramLaneFault,
  );
  expect(entry?.detail).toEqual({ fault: "shadow_incomplete" });
});

test("a query that tokenises to an empty FTS match stops being silent", async () => {
  const { vault, dbPath } = await indexedVault("trail-empty-match");
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "read" });
  try {
    const degraded: RetrievalDegradationSink = [];
    // Every token is dropped, so no lookup runs at all - which used to be
    // reported with the same empty list a vault holding no match returns.
    const outcome = runFtsQueryDetailed(store, "   ", { limit: 5, degraded });

    expect(outcome.hits).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(degraded.map((d) => d.code)).toEqual([RETRIEVAL_DEGRADATION.keywordFtsMatchEmpty]);
    // A caller that asks about a derived term, not about the query, hands
    // in no sink and the call stays byte-identical.
    expect(runFtsQueryDetailed(store, "   ", { limit: 5 }).hits).toEqual([]);
  } finally {
    await store.close();
  }
});

test("a semantic lane that cannot run names both its cause and the hybrid degrade", async () => {
  const v = createTempVault("trail-hybrid");
  cleanups.push(v.cleanup);
  writeMd(v.vault, "foo.md", "# Foo\n\nThe quick brown fox jumps over the lazy dog.");
  const cfg = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    semantic: { enabled: true, provider: "local", model: "local", dimension: 8 },
  });
  await indexVault(cfg, {}); // no embeddings written

  const out = await search(cfg, { query: "fox", limit: 5, semantic: true });

  const codes = (out.retrievalTrail?.degraded ?? []).map((d) => d.code);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.semanticEmbeddingsAbsent);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
});

// ─── an empty result explains itself ─────────────────────────────────────────

test("an empty result over a healthy index states the corpus, not a bare silence", async () => {
  const { vault, dbPath } = await indexedVault("trail-empty-healthy");

  const out = await search(makeConfig({ vault, dbPath }), {
    query: "quatorzepneumatique",
    limit: 10,
  });

  expect(out.results).toEqual([]);
  expect(out.retrievalTrail?.degraded).toEqual([]);
  expect(out.retrievalTrail?.empty?.state).toBe("not_found");
  expect((out.retrievalTrail?.empty?.reason ?? "").length).toBeGreaterThan(0);
  expect(out.retrievalTrail?.retrieved).toBe(0);
  expect(out.retrievalTrail?.pool).toBe(0);
});

test("an empty caused by a relevance floor is attributable to the floor", async () => {
  const { vault, dbPath } = await indexedVault("trail-floor");

  const out = await search(makeConfig({ vault, dbPath }), {
    query: "reindexing",
    limit: 10,
    threshold: 999,
  });

  expect(out.results).toEqual([]);
  const codes = (out.retrievalTrail?.degraded ?? []).map((d) => d.code);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.relevanceFloorDroppedRows);
  // An attributable empty does not also claim the corpus holds nothing.
  expect(out.retrievalTrail?.empty).toBeUndefined();
});

test("a scope filter that removes every hit no longer reads as an empty vault", async () => {
  const v = createTempVault("trail-scope");
  cleanups.push(v.cleanup);
  writeMd(v.vault, "a.md", "---\nsession: alpha\n---\n\n# Ops\n\nReindexing the vault is slow.");
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg, {});

  const out = await search(cfg, { query: "reindexing", limit: 10, scope: { session: "beta" } });

  expect(out.results).toEqual([]);
  const codes = (out.retrievalTrail?.degraded ?? []).map((d) => d.code);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.scopeFiltersDroppedRows);
});

// ─── the detail rule ─────────────────────────────────────────────────────────

// The namespaced half of the same rule - an origin label like
// `source/team` - is proved in `cross-vault.test.ts`, against this same
// exported pattern: the trigram lane is the only degradation this fixture
// can reach, and it emits a bare identifier.
test("detail carries identifiers and integers only", async () => {
  const { vault, dbPath } = await indexedVault("trail-detail");
  const cfg = makeConfig({
    vault,
    dbPath,
    trigramPrefilterEnabled: true,
    trigramPrefilterMinChunks: 0,
  });
  breakTrigramShadow(dbPath);

  const out = await search(cfg, { query: "reindexing", limit: 10 });

  for (const entry of out.retrievalTrail?.degraded ?? []) {
    for (const value of Object.values(entry.detail ?? {})) {
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
        continue;
      }
      // An identifier under the rule the module itself states.
      expect(value).toMatch(RETRIEVAL_DETAIL_IDENTIFIER);
    }
  }
});

// ─── the envelope ────────────────────────────────────────────────────────────

test("the envelope names one key carrying codes and counts", async () => {
  const { vault, dbPath } = await indexedVault("trail-envelope");

  const out = await search(makeConfig({ vault, dbPath }), { query: "quatorzepneumatique" });
  const envelope = retrievalTrailEnvelope(out) as Record<string, Record<string, unknown>>;

  expect(Object.keys(envelope)).toEqual([RETRIEVAL_TRAIL_KEY]);
  const trail = envelope[RETRIEVAL_TRAIL_KEY]!;
  expect(trail["retrieved"]).toBe(0);
  expect(trail["pool"]).toBe(0);
  expect(trail["degraded"]).toEqual([]);
  expect((trail["empty"] as Record<string, unknown>)["state"]).toBe("not_found");
  // Codes only: no rendered English crosses the machine boundary.
  expect(JSON.stringify(trail)).not.toContain(
    describeRetrievalDegradation(RETRIEVAL_DEGRADATION.hybridDegraded),
  );
});
