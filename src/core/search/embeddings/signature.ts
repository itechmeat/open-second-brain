/**
 * Embedding signature + cost kernel (Embedding Provider Suite).
 *
 * The single source of provider-identity truth shared by the local
 * embedder, the provider registry, the cost gate, and the store's
 * corpus-generation fingerprint. Centralising it here keeps those call
 * sites from drifting on what "the same embedding configuration" means.
 *
 * Pure and I/O-free: canonicalise an identity to a stable signature
 * string, look up a best-effort per-model price, estimate tokens and
 * spend, and compare two signatures for staleness.
 */

/**
 * Dimension field of a NAMED model whose dimension is left to the model
 * (no `embedding_dimension` configured). The model fixes its own output
 * width, so two runs of the same named model at its native width produce
 * comparable vectors: a known identity, unlike the `?` sentinel.
 */
export const MODEL_NATIVE_DIMENSION = "native";

/** Identity triple that determines whether two embeddings are comparable. */
export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string | null;
  readonly dimension: number | typeof MODEL_NATIVE_DIMENSION | null;
}

/** Model name produced by the offline local embedder (priced at 0). */
export const LOCAL_EMBEDDING_MODEL = "hashing-ngram-v1";

/** Sentinel for a null model/dimension so signatures stay parseable. */
const NULL_FIELD = "?";

/** NFC, trim, lowercase: the one normalisation for identity and price keys. */
export function canonicalToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * Canonical signature `<provider>:<model>:<dimension>`. Provider and
 * model are NFC-normalised, trimmed, and lowercased; a null model or
 * dimension renders as the stable `?` sentinel. Two configurations that
 * produce the same signature yield comparable vectors UNLESS that
 * signature carries an unknown identity - see
 * {@link signatureIdentityKnown} and {@link isStaleSignature}: the
 * rendering must stay process-stable, so unknown identity is resolved at
 * the EQUALITY layer, never by the rendering.
 */
export function embeddingSignature(id: EmbeddingIdentity): string {
  const provider = canonicalToken(id.provider);
  const model = id.model === null ? NULL_FIELD : canonicalToken(id.model);
  const dimension = id.dimension === null ? NULL_FIELD : String(id.dimension);
  return `${provider}:${model}:${dimension}`;
}

/**
 * Whether a signature carries a KNOWN embedding identity: a parseable
 * `<provider>:<model>:<dimension>` triple in which neither the model nor
 * the dimension field is the `?` sentinel. Parsed from the end, so a
 * provider or model whose canonical token contains a colon still reads.
 *
 * The `?` rendering is deliberately stable across processes - staging
 * markers and index_state outlive one run - so it cannot carry a
 * per-instance discriminator. Instead the equality layer treats an
 * unknown identity as compatible with NOTHING, not even another unknown
 * identity ({@link isStaleSignature}); this predicate is that rule's one
 * definition. A string that is not a renderable triple is not a known
 * identity either: only a well-formed rendering with no sentinel field
 * counts as known.
 */
export function signatureIdentityKnown(signature: string): boolean {
  const parts = signature.split(":");
  if (parts.length < 3) return false;
  const dimension = parts[parts.length - 1]!;
  const model = parts[parts.length - 2]!;
  return model !== NULL_FIELD && dimension !== NULL_FIELD;
}

/**
 * Builtin embedding prices in USD per million input tokens, keyed by
 * canonical model name. Rates drift as providers change pricing, so the
 * table is deliberately small. A model NOT listed has an UNKNOWN price,
 * never a price of 0: `resolveEmbeddingPrice` (`pricing.ts`) reports it
 * as unknown, an explicit positive cost gate refuses to spend on it, and
 * the operator can state its rate with the `embedding_price_model` /
 * `embedding_price_usd_per_mtok` pair, which also wins over this table.
 * The local embedder is listed explicitly at 0, so it is known to be free.
 */
export const EMBEDDING_PRICING: Readonly<Record<string, number>> = Object.freeze({
  [LOCAL_EMBEDDING_MODEL]: 0,
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.1,
});

/**
 * Characters per estimated token. Lifted out of {@link estimateTokens}
 * because the ratio now has a second reader: the store-side oversize
 * census selects the same population with a length comparison instead of
 * materialising chunk content, and a second literal `4` in that predicate
 * would be a magic number the two sites could drift on.
 */
export const CHARS_PER_ESTIMATED_TOKEN = 4;

/**
 * Cheap token estimate: a chars/4 heuristic per text, rounded up, summed.
 * This is the same order-of-magnitude approximation embedding providers
 * use for quick quotes; it intentionally avoids a real tokenizer so the
 * estimate stays dependency-free and deterministic.
 *
 * A "character" here is a UTF-16 code unit (JavaScript `String.length`),
 * which matters to any reader that reproduces this arithmetic outside
 * JavaScript - see {@link charLengthOverTokenBudget}.
 */
export function estimateTokens(texts: ReadonlyArray<string>): number {
  let total = 0;
  for (const t of texts) {
    if (t.length === 0) continue;
    total += Math.ceil(t.length / CHARS_PER_ESTIMATED_TOKEN);
  }
  return total;
}

/**
 * The character length a single text must EXCEED for its
 * {@link estimateTokens} value to exceed `tokens`.
 *
 * `ceil(L / 4) > W` holds exactly when `L > 4W` for an integer window
 * `W`, so a caller that only needs the predicate - "does this text's
 * estimate exceed the budget" - can evaluate it against a length instead
 * of computing the estimate. That is what lets the oversize-chunk census
 * run as one SQL aggregate over `chunks.content` rather than reading
 * every chunk body into memory.
 */
export function charLengthOverTokenBudget(tokens: number): number {
  return tokens * CHARS_PER_ESTIMATED_TOKEN;
}

/**
 * The most tokens the census charges a single NON-ASCII code point.
 *
 * Characters-over-four is a Latin-script rule of thumb and nothing more.
 * A BERT-family tokenizer is close to character-level on Han text, so a
 * Chinese passage costs roughly one token per character - four times what
 * {@link estimateTokens} predicts. One token per non-ASCII code point is
 * the widest per-character cost this census models, and it is what makes
 * the ceiling below an upper bound for the scripts these presets target
 * rather than another Latin-only guess.
 */
export const MAX_TOKENS_PER_NON_ASCII_CODE_POINT = 1;

/**
 * The two quantities SQLite can measure over a TEXT column without
 * materialising it: `length()` (Unicode CODE POINTS) and
 * `octet_length()` (UTF-8 BYTES).
 *
 * They are the census's whole input, and between them they carry a
 * structural script signal: a code point outside ASCII costs at least one
 * extra UTF-8 byte, so `utf8Bytes - codePoints` is an exact upper bound on
 * how many of a text's code points are non-ASCII. That is a property of
 * the UTF-8 encoding, not a language list, and it holds for every script.
 */
export interface TextExtent {
  readonly codePoints: number;
  readonly utf8Bytes: number;
}

const UTF8 = new TextEncoder();

/** Measure a JavaScript string the way SQLite measures a TEXT value. */
export function textExtent(text: string): TextExtent {
  return Object.freeze({
    codePoints: [...text].length,
    utf8Bytes: UTF8.encode(text).length,
  });
}

/** Non-ASCII code points in a text, at most - see {@link TextExtent}. */
function maxNonAsciiCodePoints(extent: TextExtent): number {
  return Math.min(extent.codePoints, extent.utf8Bytes - extent.codePoints);
}

/**
 * Fewest tokens the text can plausibly cost: every code point at a
 * quarter token, which is {@link estimateTokens} generalised from UTF-16
 * code units to code points.
 *
 * Code points rather than code units because that is the unit SQLite
 * counts, and because it is the SMALLER of the two - a supplementary-plane
 * character is one code point and two code units - so the floor stays a
 * floor on both sides of the seam.
 */
export function tokenEstimateFloor(extent: TextExtent): number {
  return Math.ceil(extent.codePoints / CHARS_PER_ESTIMATED_TOKEN);
}

/**
 * Most tokens the text can plausibly cost: every non-ASCII code point at
 * {@link MAX_TOKENS_PER_NON_ASCII_CODE_POINT}, the rest at a quarter
 * token each.
 *
 * Equal to {@link tokenEstimateFloor} for pure ASCII, which is what keeps
 * an all-Latin index reporting exactly what it reported before this
 * two-sided bound existed.
 */
export function tokenEstimateCeiling(extent: TextExtent): number {
  const nonAscii = maxNonAsciiCodePoints(extent);
  const rest = extent.codePoints - nonAscii;
  return (
    nonAscii * MAX_TOKENS_PER_NON_ASCII_CODE_POINT + Math.ceil(rest / CHARS_PER_ESTIMATED_TOKEN)
  );
}

/**
 * Coefficient on the non-ASCII code-point count in the integer form of
 * `tokenEstimateCeiling(e) > W`.
 *
 * `n * M + ceil((C - n) / 4) > W` is equivalent, over integers, to
 * `C + (4M - 1) * n > 4W`. Exported because the census evaluates that
 * comparison in SQL, where the division cannot be rounded, and a second
 * literal there would be the drift this constant exists to prevent.
 */
export const NON_ASCII_CEILING_COEFFICIENT =
  CHARS_PER_ESTIMATED_TOKEN * MAX_TOKENS_PER_NON_ASCII_CODE_POINT - 1;

/**
 * The UTF-8 byte length a text must EXCEED before
 * {@link tokenEstimateCeiling} can possibly exceed `tokens` - a test on
 * the one measurement that is free.
 *
 * Write `k` for {@link NON_ASCII_CEILING_COEFFICIENT}, `C` for code
 * points and `B` for bytes. The ceiling's integer form is `C + k*n` with
 * `n = min(C, B - C)`, and over the admissible range of `C` for a given
 * `B` that expression peaks at `C = B/2`, where it equals `(1 + k)*B/2`.
 * So a text can only be over budget `4W` when `(1 + k)*B/2 > 4W`, which
 * is `B > 8W / (1 + k)`.
 *
 * Worth stating as its own predicate because SQLite answers it without
 * decoding anything: `octet_length()` reads a stored byte count, while
 * `length()` walks the whole UTF-8 string. On a model with a wide window
 * this skips the walk for the entire chunk table.
 */
export function utf8ByteFloorUnderTokenBudget(tokens: number): number {
  return Math.floor(
    (2 * charLengthOverTokenBudget(tokens)) /
      (CHARS_PER_ESTIMATED_TOKEN * MAX_TOKENS_PER_NON_ASCII_CODE_POINT),
  );
}

/** Tokens per unit of a per-million-token rate. */
const TOKENS_PER_PRICED_UNIT = 1_000_000;

/**
 * The rate half of a price quote (`PriceQuote` in `pricing.ts`), stated
 * structurally so this kernel imports nothing from the resolver that
 * imports it: null means nobody stated the price.
 */
interface QuotedRate {
  readonly usdPerMtok: number | null;
}

/**
 * Estimated spend in USD for `tokens` at the quoted rate: null when the
 * price is unknown, so an unpriced model never reads as free.
 */
export function estimateCostUsd(tokens: number, quote: { readonly usdPerMtok: number }): number;
export function estimateCostUsd(tokens: number, quote: QuotedRate): number | null;
export function estimateCostUsd(tokens: number, quote: QuotedRate): number | null {
  if (quote.usdPerMtok === null) return null;
  if (quote.usdPerMtok === 0) return 0;
  return (tokens / TOKENS_PER_PRICED_UNIT) * quote.usdPerMtok;
}

/**
 * True when the active signature must NOT be treated as the stored one.
 *
 * Plain string difference, PLUS the unknown-identity rule: a signature
 * whose model or dimension field is the `?` sentinel is stale against
 * EVERYTHING, including an identical copy of itself, because an unknown
 * identity is compatible with nothing. Callers decide warn vs refuse per
 * the `embedding_abi` gate; this predicate only stops the equality from
 * lying.
 */
export function isStaleSignature(active: string, stored: string): boolean {
  if (!signatureIdentityKnown(active) || !signatureIdentityKnown(stored)) return true;
  return active !== stored;
}
