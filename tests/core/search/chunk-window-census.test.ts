/**
 * The oversize-chunk census (what-the-index-already-knew, task H).
 *
 * Two shipped defaults overflow each other in silence: the chunker cuts
 * at `search_chunk_size` whitespace WORDS while the recommended model
 * declares an input window in TOKENS, several times smaller. Every
 * window number in this file is read from the preset table rather than
 * written down, so a corrected model card is a one-line edit there and
 * nothing here goes stale. A provider that truncates does so
 * server-side and returns a vector of the right width for a prefix of
 * the passage, so nothing local can observe it. The census is what
 * makes the condition observable, and it is arithmetic available
 * entirely offline.
 *
 * Three properties are pinned here, and each one can fail:
 *
 *   - the predicate the store evaluates is EXACTLY the estimator the
 *     embedding request path sizes batches with, proved by brute force
 *     rather than by inspection;
 *   - the ONE place the two disagree - SQLite counts code points where
 *     JavaScript counts UTF-16 code units - is pinned as a bound and a
 *     direction, not left to be discovered;
 *   - a model with no declared window reports that the check did not
 *     run. Never that it passed.
 *
 * The two verdicts leave `o2b search status` by different doors, and
 * that split is pinned here too. Measured overflow is a warning: it is a
 * fault with a command behind it. An undeclared window is a structured
 * field: there is no command that declares a window for someone else's
 * model, and it is the COMMON case, so a warning would repeat forever
 * and cost the channel its meaning. Both states remain distinguishable
 * from a pass, which is the property that matters.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexStatus, indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  charLengthOverTokenBudget,
  estimateTokens,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import {
  declaredInputWindowTokens,
  EMBEDDING_MODEL_PRESETS,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/presets.ts";
import { requireNextStep } from "../../../src/core/brain/next-step.ts";
import { serializeIndexStatus } from "../../../src/core/search/serialize.ts";
import { chunkWindowDiagnosticCode } from "../../../src/core/search/types.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("chunk-window");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

/** The curated window that governs the shipped recommended default. */
const RECOMMENDED_WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

/** A model string deliberately outside the curated table. */
const UNCURATED_MODEL = "acme/custom-embed-9000";

function cfg(
  semantic: Partial<ResolvedEmbeddingConfig> = {},
  overrides: Partial<ResolvedSearchConfig> = {},
): ResolvedSearchConfig {
  return Object.freeze({
    ...makeConfig({
      vault,
      dbPath,
      semantic: {
        enabled: true,
        provider: "openai-compat",
        // Never reached: no test here computes embeddings, so no request
        // is ever made. The census is a read over already-indexed rows.
        baseUrl: "https://embeddings.invalid/v1",
        model: RECOMMENDED_EMBEDDING_MODEL,
        apiKey: "test-key",
        dimension: 384,
        ...semantic,
      },
    }),
    ...overrides,
  });
}

/** A note body that is one chunk and comfortably over `window` tokens. */
function oversizeBody(windowTokens: number): string {
  return "overflow ".repeat(charLengthOverTokenBudget(windowTokens));
}

// ── the predicate is the estimator ───────────────────────────────────────────

test("the census predicate equals the request path's estimator at every length", () => {
  for (const windowTokens of [1, 8, 128, RECOMMENDED_WINDOW]) {
    const threshold = charLengthOverTokenBudget(windowTokens);
    for (let len = 0; len <= threshold + 8; len++) {
      const text = "a".repeat(len);
      const byEstimator = estimateTokens([text]) > windowTokens;
      const byLength = len > threshold;
      expect(`w=${windowTokens} len=${len}: ${byLength}`).toBe(
        `w=${windowTokens} len=${len}: ${byEstimator}`,
      );
    }
  }
});

// ── the presets declare a window ─────────────────────────────────────────────

test("every curated preset declares a positive integer input window", () => {
  for (const p of EMBEDDING_MODEL_PRESETS) {
    expect(`${p.model}: ${Number.isInteger(p.inputWindowTokens)}`).toBe(`${p.model}: true`);
    expect(p.inputWindowTokens).toBeGreaterThan(0);
  }
});

test("an uncurated model declares no window, and null is not zero", () => {
  expect(declaredInputWindowTokens(UNCURATED_MODEL)).toBeNull();
  expect(declaredInputWindowTokens(null)).toBeNull();
  // The polarity that matters: unlike the price table, an absent entry
  // does not resolve to a permissive number.
  expect(declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)).toBe(RECOMMENDED_WINDOW);
});

test("the shipped defaults are the ones that overflow each other", async () => {
  // The arithmetic the unit exists for, asserted rather than described:
  // a default-sized chunk of ordinary prose estimates well past the
  // recommended model's declared window.
  const config = cfg();
  const wordsPerChunk = config.chunkSize;
  const averageWord = "retrieval ".length;
  expect(estimateTokens(["x".repeat(wordsPerChunk * averageWord)])).toBeGreaterThan(
    RECOMMENDED_WINDOW * 2,
  );
});

// ── the store-side count ─────────────────────────────────────────────────────

test("the store counts exactly the chunks whose estimate exceeds the window", async () => {
  const window = 16;
  const threshold = charLengthOverTokenBudget(window);
  const store = await Store.open(cfg(), { mode: "write" });
  try {
    const docId = store.upsertDocument({
      path: "a.md",
      title: "A",
      contentHash: "hash-a",
      mtime: 1,
      size: 1,
      pageType: null,
      authoredAt: null,
      eventAnchor: null,
    });
    store.replaceChunks(docId, [
      {
        chunkIndex: 0,
        content: "b".repeat(threshold),
        contentHash: "h0",
        startLine: 1,
        endLine: 1,
        tokenCount: 1,
      },
      {
        chunkIndex: 1,
        content: "b".repeat(threshold + 1),
        contentHash: "h1",
        startLine: 2,
        endLine: 2,
        tokenCount: 1,
      },
      {
        chunkIndex: 2,
        content: "b".repeat(threshold * 3),
        contentHash: "h2",
        startLine: 3,
        endLine: 3,
        tokenCount: 1,
      },
      { chunkIndex: 3, content: "", contentHash: "h3", startLine: 4, endLine: 4, tokenCount: 0 },
    ]);
    // Exactly the two over the boundary - the one AT it is not over it,
    // which is the same boundary `estimateTokens` draws.
    expect(store.chunksOverTokenWindow(window)).toBe(2);
    expect(store.chunksOverTokenWindow(window * 4)).toBe(0);
  } finally {
    await store.close();
  }
});

test("the code-point / code-unit divergence is a lower bound, and only that", async () => {
  const window = 16;
  const threshold = charLengthOverTokenBudget(window);
  // A supplementary-plane character is ONE code point to SQLite's
  // length() and TWO code units to String.length. A chunk built entirely
  // from them sits at the threshold in the database and past it in the
  // estimator, so the census declines to count it.
  const astral = "\u{1F600}".repeat(threshold);
  expect(astral.length).toBe(threshold * 2);
  expect(estimateTokens([astral])).toBeGreaterThan(window);

  const store = await Store.open(cfg(), { mode: "write" });
  try {
    const docId = store.upsertDocument({
      path: "astral.md",
      title: null,
      contentHash: "hash-astral",
      mtime: 1,
      size: 1,
      pageType: null,
      authoredAt: null,
      eventAnchor: null,
    });
    store.replaceChunks(docId, [
      {
        chunkIndex: 0,
        content: astral,
        contentHash: "h0",
        startLine: 1,
        endLine: 1,
        tokenCount: 1,
      },
    ]);
    // The stated bound: never a false alarm, and short by at most one
    // code unit per supplementary character.
    expect(store.chunksOverTokenWindow(window)).toBe(0);
    // One more astral character past the code-point threshold and the
    // count fires, so the divergence is a bound and not a blind spot.
    store.replaceChunks(docId, [
      {
        chunkIndex: 0,
        content: "\u{1F600}".repeat(threshold + 1),
        contentHash: "h1",
        startLine: 1,
        endLine: 1,
        tokenCount: 1,
      },
    ]);
    expect(store.chunksOverTokenWindow(window)).toBe(1);
  } finally {
    await store.close();
  }
});

// ── the census verdicts ──────────────────────────────────────────────────────

test("an index whose chunks exceed the declared window reports a counted verdict", async () => {
  writeMd(vault, "big.md", `# Big\n\n${oversizeBody(RECOMMENDED_WINDOW)}\n`);
  const stats = await indexVault(cfg());
  expect(stats.chunkWindow?.verdict).toBe("over-window");
  const census = stats.chunkWindow!;
  if (census.verdict !== "over-window") throw new Error("verdict narrowed wrong");
  expect(census.model).toBe(RECOMMENDED_EMBEDDING_MODEL);
  expect(census.windowTokens).toBe(RECOMMENDED_WINDOW);
  expect(census.chunksOverWindow).toBeGreaterThan(0);
  expect(census.chunksOverWindow).toBeLessThanOrEqual(census.chunksMeasured);
});

test("an index whose chunks fit reports NOTHING - the field is absent, not zero", async () => {
  writeMd(vault, "small.md", "# Small\n\nA short note that fits any window.\n");
  const stats = await indexVault(cfg());
  expect("chunkWindow" in stats).toBe(false);
  expect(stats.chunkWindow).toBeUndefined();
});

test("a model with no declared window reports that the check did not run", async () => {
  writeMd(vault, "small.md", "# Small\n\nA short note that fits any window.\n");
  const stats = await indexVault(cfg({ model: UNCURATED_MODEL }));
  const census = stats.chunkWindow;
  expect(census?.verdict).toBe("window-undeclared");
  if (census?.verdict !== "window-undeclared") throw new Error("verdict narrowed wrong");
  expect(census.model).toBe(UNCURATED_MODEL);
  expect(census.chunksMeasured).toBeGreaterThan(0);
  // The failure mode this unit exists to prevent: the same vault under a
  // curated model reports nothing at all, so "silent" must not be the
  // uncurated model's answer too.
  expect("chunkWindow" in (await indexVault(cfg(), { force: true }))).toBe(false);
});

test("semantic search off and the offline embedder both take no census", async () => {
  writeMd(vault, "big.md", `# Big\n\n${oversizeBody(RECOMMENDED_WINDOW)}\n`);
  // Off: nothing is ever embedded, so no window can be exceeded.
  expect("chunkWindow" in (await indexVault(cfg({ enabled: false })))).toBe(false);
  // Local: feature hashing over the whole text - no encoder, no
  // positional limit. A provably absent window, not an unknown one.
  const local = await indexVault(cfg({ provider: "local", model: LOCAL_EMBEDDING_MODEL }), {
    force: true,
  });
  expect("chunkWindow" in local).toBe(false);
});

// ── the warning surface ──────────────────────────────────────────────────────

test("search status warns with the registered exit when chunks exceed the window", async () => {
  writeMd(vault, "big.md", `# Big\n\n${oversizeBody(RECOMMENDED_WINDOW)}\n`);
  await indexVault(cfg());
  const status = await indexStatus(cfg());
  const expectedCommand = requireNextStep("search-chunk-window-overflow").nextCommand;
  const warning = status.warnings.find((w) => w.includes(expectedCommand));
  expect(warning ?? "(no chunk-window warning)").toContain(RECOMMENDED_EMBEDDING_MODEL);
  expect(warning!).toContain(String(RECOMMENDED_WINDOW));
  // The other half of the remedy - the setting that produced the
  // boundaries - is named too, because a rebuild alone re-cuts the same
  // chunks.
  expect(warning!).toContain("search_chunk_size");
});

test("an uncurated model is a status FIELD, never a status warning", async () => {
  writeMd(vault, "small.md", "# Small\n\nA short note.\n");
  await indexVault(cfg({ model: UNCURATED_MODEL }));
  const status = await indexStatus(cfg({ model: UNCURATED_MODEL }));

  // The statement is made, so nothing here reads as a pass...
  expect(status.chunkWindowUndeclared?.verdict).toBe("window-undeclared");
  expect(status.chunkWindowUndeclared!.model).toBe(UNCURATED_MODEL);
  expect(status.chunkWindowUndeclared!.chunksMeasured).toBeGreaterThan(0);

  // ...and it is made WITHOUT spending the warning channel, which is
  // reserved for conditions that name a command. This is the common
  // case - most models are outside the curated table - so a warning
  // here would repeat forever and train operators to skip the channel.
  expect(status.warnings).toEqual([]);
});

test("a clean census sets no status field and no status warning", async () => {
  writeMd(vault, "small.md", "# Small\n\nA short note.\n");
  await indexVault(cfg());
  const status = await indexStatus(cfg());
  expect("chunkWindowUndeclared" in status).toBe(false);
  for (const code of ["search-chunk-window-overflow", "search-chunk-window-undeclared"]) {
    const command = requireNextStep(code).nextCommand;
    expect(`${code}: ${status.warnings.some((w) => w.includes(command))}`).toBe(`${code}: false`);
  }
});

test("measured overflow leaves the undeclared field absent", async () => {
  writeMd(vault, "big.md", `# Big\n\n${oversizeBody(RECOMMENDED_WINDOW)}\n`);
  await indexVault(cfg());
  const status = await indexStatus(cfg());
  // Three distinguishable states on one surface: this one is measured
  // and faulty, so it is a warning and NOT the unmeasurable field.
  expect("chunkWindowUndeclared" in status).toBe(false);
  expect(status.warnings.length).toBeGreaterThan(0);
});

test("the status wire shape carries the field only when the check could not run", async () => {
  writeMd(vault, "small.md", "# Small\n\nA short note.\n");

  await indexVault(cfg({ model: UNCURATED_MODEL }));
  const undeclared = serializeIndexStatus(await indexStatus(cfg({ model: UNCURATED_MODEL })));
  expect(undeclared["chunk_window_undeclared"]).toEqual({
    verdict: "window-undeclared",
    model: UNCURATED_MODEL,
    chunks_measured: 1,
  });

  await indexVault(cfg(), { force: true });
  const curated = serializeIndexStatus(await indexStatus(cfg()));
  expect("chunk_window_undeclared" in curated).toBe(false);
  // The bytes either side of where the key would have landed are the
  // pre-census bytes.
  expect(JSON.stringify(curated)).not.toContain("chunk_window");
});

// ── every verdict names a registered exit ────────────────────────────────────

test("both census verdicts resolve to a registered command", () => {
  const overflow = chunkWindowDiagnosticCode({
    verdict: "over-window",
    model: RECOMMENDED_EMBEDDING_MODEL,
    windowTokens: RECOMMENDED_WINDOW,
    chunksOverWindow: 1,
    chunksMeasured: 1,
  });
  const undeclared = chunkWindowDiagnosticCode({
    verdict: "window-undeclared",
    model: UNCURATED_MODEL,
    chunksMeasured: 1,
  });
  expect(requireNextStep(overflow).nextCommand.startsWith("o2b ")).toBe(true);
  expect(requireNextStep(undeclared).nextCommand.startsWith("o2b ")).toBe(true);
  // Different states, different exits: a rebuild does not answer "no
  // window is declared for this model".
  expect(requireNextStep(overflow).nextCommand).not.toBe(requireNextStep(undeclared).nextCommand);
});
