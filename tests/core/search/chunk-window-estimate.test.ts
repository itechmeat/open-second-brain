/**
 * What the oversize-chunk census can and cannot decide
 * (what-the-index-already-knew, task H follow-up).
 *
 * The census exists so a truncating provider stops being invisible. Three
 * ways it was still silent about chunks the provider truncates, each
 * reproduced here before it was fixed:
 *
 *   - the request path PREFIXES every passage (`passage: ` for the
 *     recommended e5 default) and the census did not, so a chunk sitting
 *     inside the prefix's width of the window was over in the request and
 *     zero in the count;
 *   - characters-over-four is not a token estimate on Han text, where a
 *     BERT-family tokenizer is roughly character-level. A vault under
 *     `BAAI/bge-small-zh-v1.5` was several times over its window and the
 *     census emitted nothing on any surface;
 *   - SQLite counts code points where the estimator counts UTF-16 code
 *     units, so fully-astral text reads HALF its estimated size in the
 *     database - a chunk estimated at twice the window was missed.
 *
 * All three shared one shape: the census said nothing, and nothing was
 * defined to mean "every chunk fits". The fix is two arms with a stated
 * boundary between them: `over-window` is the HOLD population, decided by
 * the conservative hold bound (`tokenHoldFloor`, a code point charged at
 * no more than a twelfth of a token) - the only estimate that reads as
 * proof, after the chars-over-four average was caught holding chunks that
 * fit; and `undecided` is everything the proof cannot settle, whose high
 * estimate still reads over the window and which is reported, still sent.
 * Silence is earned rather than assumed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexStatus } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  estimateTokens,
  textExtent,
  tokenEstimateCeiling,
  tokenHoldFloor,
  utf8ByteFloorUnderTokenBudget,
} from "../../../src/core/search/embeddings/signature.ts";
import {
  declaredInputWindowTokens,
  E5_PASSAGE_PREFIX,
  passagePrefixSentByProvider,
  RECOMMENDED_EMBEDDING_MODEL,
  resolveEmbeddingPrefixes,
} from "../../../src/core/search/embeddings/presets.ts";
import { requireNextStep } from "../../../src/core/brain/next-step.ts";
import type {
  EmbeddingProviderName,
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("chunk-window-estimate");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

const RECOMMENDED_WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;
const ZH_MODEL = "BAAI/bge-small-zh-v1.5";
const ZH_WINDOW = declaredInputWindowTokens(ZH_MODEL)!;

/** The prefix real config resolution hands the recommended default. */
const RESOLVED_PASSAGE_PREFIX = resolveEmbeddingPrefixes(
  RECOMMENDED_EMBEDDING_MODEL,
  null,
  null,
).passagePrefix;

function cfg(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: "https://embeddings.invalid/v1",
      model: RECOMMENDED_EMBEDDING_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 384,
      passagePrefix: RESOLVED_PASSAGE_PREFIX,
      ...semantic,
    },
  });
}

/** Write one chunk body straight into the index and close it. */
async function seedOneChunk(config: ResolvedSearchConfig, content: string): Promise<void> {
  const store = await Store.open(config, { mode: "write" });
  try {
    const docId = store.upsertDocument({
      path: "seed.md",
      title: "Seed",
      contentHash: "hash-seed",
      mtime: 1,
      size: content.length,
      pageType: null,
      authoredAt: null,
      eventAnchor: null,
    });
    store.replaceChunks(docId, [
      {
        chunkIndex: 0,
        content,
        contentHash: "chunk-seed",
        startLine: 1,
        endLine: 1,
        tokenCount: 1,
      },
    ]);
  } finally {
    await store.close();
  }
}

/** Every operator-visible statement the census makes on the status surface. */
async function censusSurface(config: ResolvedSearchConfig): Promise<{
  warnings: ReadonlyArray<string>;
  undeclared: boolean;
}> {
  const status = await indexStatus(config);
  return { warnings: status.warnings, undeclared: status.chunkWindowUndeclared !== undefined };
}

const OVERFLOW_COMMAND = requireNextStep("search-chunk-window-overflow").nextCommand;

// ── 1. the prefix the provider will actually send ────────────────────────────

test("a chunk pushed over the window BY the instruction prefix is counted", async () => {
  // The recommended multilingual default auto-resolves a 9-character
  // passage prefix, and the request path prepends it before the provider
  // ever counts a token.
  expect(RESOLVED_PASSAGE_PREFIX).toBe(E5_PASSAGE_PREFIX);

  const content = "a".repeat(RECOMMENDED_WINDOW * 4);
  // Without the prefix the average estimate lands exactly ON the window;
  // with it, over. The request always carries it, so this chunk is in
  // the census's undecided band - reported, never a pass.
  expect(estimateTokens([content])).toBe(RECOMMENDED_WINDOW);
  expect(estimateTokens([RESOLVED_PASSAGE_PREFIX + content])).toBeGreaterThan(RECOMMENDED_WINDOW);

  await seedOneChunk(cfg(), content);
  const surface = await censusSurface(cfg());
  const warning = surface.warnings.find((w) => w.includes(OVERFLOW_COMMAND));
  expect(warning ?? "(the census said nothing)").toContain(String(RECOMMENDED_WINDOW));
});

test("a chunk pushed over the hold bound BY the instruction prefix is counted as over", async () => {
  // The same charge at the hold bound itself: this body fits the window
  // by exactly one code point, and the prefix the backend sends is what
  // puts the request over it. The verdict is the over-window arm, the
  // one the embedding phase holds on.
  const content = "a".repeat(RECOMMENDED_WINDOW * 12 - RESOLVED_PASSAGE_PREFIX.length + 1);
  expect(tokenHoldFloor(textExtent(content))).toBe(RECOMMENDED_WINDOW);
  expect(tokenHoldFloor(textExtent(RESOLVED_PASSAGE_PREFIX + content))).toBeGreaterThan(
    RECOMMENDED_WINDOW,
  );

  await seedOneChunk(cfg(), content);
  const status = await indexStatus(cfg());
  const warning = status.warnings.find((w) => w.includes(OVERFLOW_COMMAND));
  expect(warning ?? "(the census said nothing)").toContain("held");
});

test("a provider that sends no prefix has none subtracted", async () => {
  // ZeroEntropy embeds the raw text: its `embed` takes no kind and
  // prepends nothing, so the same chunk is exactly at the window and the
  // census must stay silent rather than borrow another provider's prefix.
  const zeroentropy = cfg({ provider: "zeroentropy" });
  await seedOneChunk(zeroentropy, "a".repeat(RECOMMENDED_WINDOW * 4));
  const surface = await censusSurface(zeroentropy);
  expect(surface.warnings).toEqual([]);
  expect(surface.undeclared).toBe(false);
});

// ── 2. Han text against a Han model ──────────────────────────────────────────

test("a Han-script vault over its declared window is not silent", async () => {
  // A BERT-family Chinese tokenizer is roughly character-level, so this
  // body is about 3.6x the model's 512-token window. Characters-over-four
  // estimates it at a quarter of that and reports a clean census.
  const han = "文".repeat(Math.round(ZH_WINDOW * 3.6));
  expect(estimateTokens([han])).toBeLessThan(ZH_WINDOW);

  const config = cfg({ model: ZH_MODEL, passagePrefix: "" });
  await seedOneChunk(config, han);
  const surface = await censusSurface(config);
  expect(`${surface.warnings.length} warning(s), undeclared=${surface.undeclared}`).not.toBe(
    "0 warning(s), undeclared=false",
  );
  expect(surface.warnings.join("\n")).toContain(OVERFLOW_COMMAND);
});

// ── 3. the astral bound ──────────────────────────────────────────────────────

test("a fully astral chunk estimated well past the window is not silent", async () => {
  // SQLite's length() counts code points; the estimator counts UTF-16
  // code units. For fully-astral text the database reads HALF the
  // estimated size, so a chunk estimated at nearly twice the window fell
  // under a threshold expressed in code points.
  const astral = "\u{1F600}".repeat(RECOMMENDED_WINDOW * 4 - 48);
  expect(estimateTokens([RESOLVED_PASSAGE_PREFIX + astral])).toBeGreaterThan(
    RECOMMENDED_WINDOW * 1.9,
  );

  await seedOneChunk(cfg(), astral);
  const surface = await censusSurface(cfg());
  expect(`${surface.warnings.length} warning(s), undeclared=${surface.undeclared}`).not.toBe(
    "0 warning(s), undeclared=false",
  );
});

// ── 4. the silence that IS earned ────────────────────────────────────────────

test("an all-ASCII chunk comfortably inside the window still says nothing", async () => {
  await seedOneChunk(cfg(), "a".repeat(RECOMMENDED_WINDOW));
  const surface = await censusSurface(cfg());
  expect(surface.warnings).toEqual([]);
  expect(surface.undeclared).toBe(false);
});

// ── the two arms, as arithmetic ──────────────────────────────────────────────

test("for pure ASCII the high estimate IS the average one", () => {
  for (let len = 0; len <= 64; len++) {
    const text = "a".repeat(len);
    const extent = textExtent(text);
    expect(`len=${len} ceiling=${tokenEstimateCeiling(extent)}`).toBe(
      `len=${len} ceiling=${estimateTokens([text])}`,
    );
  }
});

test("the hold bound clears prose the average estimate would hold", () => {
  // The defect that moved the hold to a conservative bound: a real
  // English paragraph of 519 code points costs about 111 tokens under
  // the shipped preset families' 4.5-9 code points per token, so it fits
  // the narrowest shipped window (128) - while the chars-over-four
  // average reads 130 and held it from embedding for nothing.
  const paragraph =
    "The survey team recorded every measurement in the ledger before the storm reached " +
    "the harbour wall, and the notes survived the night in a dry canvas bag. ";
  const prose = paragraph.repeat(Math.ceil(519 / paragraph.length)).slice(0, 519);
  const extent = textExtent(prose);
  expect(extent.codePoints).toBe(519);
  expect(Math.ceil(extent.codePoints / 4)).toBe(130);
  expect(Math.ceil(extent.codePoints / 4)).toBeGreaterThan(128);
  expect(tokenHoldFloor(extent)).toBeLessThanOrEqual(128);
});

test("the ceiling brackets what the average estimate under-reports on Han and astral text", () => {
  // Han: about one token per character under a BERT-family tokenizer.
  const han = "文".repeat(400);
  expect(estimateTokens([han])).toBe(100);
  expect(tokenEstimateCeiling(textExtent(han))).toBe(400);
  // Astral: SQLite reads half of what String.length reads, and the
  // ceiling covers both readings.
  const astral = "\u{1F600}".repeat(400);
  expect(tokenHoldFloor(textExtent(astral))).toBe(34);
  expect(estimateTokens([astral])).toBe(200);
  expect(tokenEstimateCeiling(textExtent(astral))).toBe(400);
});

test("the hold bound never exceeds the ceiling, over every script mixture", () => {
  const alphabets = ["a", "é", "文", "\u{1F600}", " ", "Ж"];
  for (const first of alphabets) {
    for (const second of alphabets) {
      for (const repeats of [0, 1, 3, 17]) {
        const text = (first + second).repeat(repeats);
        const extent = textExtent(text);
        const bound = tokenHoldFloor(extent);
        const ceiling = tokenEstimateCeiling(extent);
        expect(`${JSON.stringify(text)}: ${bound <= ceiling}`).toBe(
          `${JSON.stringify(text)}: true`,
        );
      }
    }
  }
});

test("the byte prefilter never skips a text either census arm would flag", () => {
  // The query tests the free measurement first and walks only the
  // survivors. That is only sound if a text under the byte floor is
  // provably under BOTH arms - the hold bound and the high estimate - so
  // prove it by brute force over every script mixture and every length
  // either arm can straddle.
  const units = ["a", "ab", "é", "文", "\u{1F600}", "Ж文", "a文", "\u{1F600}a"];
  for (const windowTokens of [1, 4, 16, 128, 512]) {
    const floor = utf8ByteFloorUnderTokenBudget(windowTokens);
    for (const unit of units) {
      for (let repeats = 0; repeats <= 40; repeats++) {
        const extent = textExtent(unit.repeat(repeats));
        if (extent.utf8Bytes > floor) continue;
        const flagged =
          tokenHoldFloor(extent) > windowTokens || tokenEstimateCeiling(extent) > windowTokens;
        expect(`w=${windowTokens} ${JSON.stringify(unit)}x${repeats}: ${flagged}`).toBe(
          `w=${windowTokens} ${JSON.stringify(unit)}x${repeats}: false`,
        );
      }
    }
  }
});

// ── the store evaluates exactly those two predicates ─────────────────────────

test("the SQL tally reproduces the two census arms chunk for chunk", async () => {
  const windowTokens = 16;
  const prefix = RESOLVED_PASSAGE_PREFIX;
  const holdBoundary = windowTokens * 12; // code points past this are held
  const averageBoundary = windowTokens * 4; // past this the high estimate reads over
  const bodies: string[] = [];
  // Straddle the hold bound in ASCII, then the undecided band below it,
  // then the high estimate in four other scripts, then the empty chunk.
  for (const len of [
    holdBoundary - prefix.length - 1,
    holdBoundary - prefix.length,
    holdBoundary - prefix.length + 1,
  ]) {
    bodies.push("a".repeat(len));
  }
  for (const len of [averageBoundary - prefix.length - 1, averageBoundary - prefix.length]) {
    bodies.push("a".repeat(Math.max(0, len)));
  }
  for (const unit of ["文", "\u{1F600}", "Ж", "é"]) {
    for (const count of [1, windowTokens, windowTokens + 1, averageBoundary, holdBoundary + 1]) {
      bodies.push(unit.repeat(count));
    }
  }
  bodies.push("");

  const store = await Store.open(cfg(), { mode: "write" });
  try {
    const docId = store.upsertDocument({
      path: "mixed.md",
      title: null,
      contentHash: "hash-mixed",
      mtime: 1,
      size: 1,
      pageType: null,
      authoredAt: null,
      eventAnchor: null,
    });
    store.replaceChunks(
      docId,
      bodies.map((content, i) => ({
        chunkIndex: i,
        content,
        contentHash: `h${i}`,
        startLine: i + 1,
        endLine: i + 1,
        tokenCount: 1,
      })),
    );

    let overWindow = 0;
    let undecided = 0;
    for (const body of bodies) {
      const extent = textExtent(prefix + body);
      if (tokenHoldFloor(extent) > windowTokens) overWindow++;
      else if (tokenEstimateCeiling(extent) > windowTokens) undecided++;
    }
    // The fixture must actually exercise both arms, or this test would
    // pass over a census that never counted anything.
    expect(`over=${overWindow > 0} undecided=${undecided > 0}`).toBe("over=true undecided=true");
    expect(store.chunkWindowTally(windowTokens, prefix)).toEqual({ overWindow, undecided });
  } finally {
    await store.close();
  }
});

// ── the prefix belongs to the backend, not to the config ─────────────────────

test("every embedding backend declares whether it sends a passage prefix", () => {
  const providers: ReadonlyArray<EmbeddingProviderName> = [
    "openai-compat",
    "zeroentropy",
    "local",
    "disabled",
  ];
  const sent = providers.map(
    (p) => `${p}=${JSON.stringify(passagePrefixSentByProvider(p, "P: "))}`,
  );
  // Only the OpenAI-compatible backend implements `prefixFor`; the rest
  // send the raw text, so a configured prefix must not be subtracted for
  // them. Adding a backend fails to compile in `presets.ts` rather than
  // defaulting into this list silently.
  expect(sent).toEqual(['openai-compat="P: "', 'zeroentropy=""', 'local=""', 'disabled=""']);
  // An absent configured prefix is no prefix; an empty one is disabled.
  // Both match `OpenAICompatProvider.prefixFor` exactly.
  expect(passagePrefixSentByProvider("openai-compat", undefined)).toBe("");
  expect(passagePrefixSentByProvider("openai-compat", "")).toBe("");
});
