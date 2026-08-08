/**
 * Curated embedding-model presets (Retrieval & Ranking Quality).
 *
 * A static, shippable catalog of known-good embedding models surfaced when
 * a user registers an OpenAI-compatible provider, plus a recommended
 * multilingual default. Advisory only: the free-form custom `--model`
 * entry stays first-class, and OSB targets arbitrary OpenAI-compatible
 * endpoints, so a preset is guidance (model string + dimension + a note),
 * never a constraint. No server, no network - the list is consulted
 * entirely at registration time.
 *
 * Presets are multilingual-first because OSB is language-agnostic: a
 * multilingual default avoids the dimension/quality mistakes that later
 * force a full re-embed. The `dimension` is the model's native embedding
 * width, useful when setting `embedding_dimension` up front.
 */

import type { EmbeddingProviderName } from "../types.ts";

/**
 * Instruction prefix an e5-family model expects before a search query
 * (memory-write-path-integrity B2). Trailing space is intentional: the model
 * was trained on `"query: <text>"`.
 */
export const E5_QUERY_PREFIX = "query: ";
/** Instruction prefix an e5-family model expects before an indexed passage. */
export const E5_PASSAGE_PREFIX = "passage: ";

/** One curated embedding model the registration flow can recommend. */
export interface EmbeddingModelPreset {
  /** Model string sent to the endpoint (`embedding_model` / profile defaultModel). */
  readonly model: string;
  /** Short human label for CLI listings. */
  readonly label: string;
  /** Native embedding dimension. */
  readonly dimension: number;
  /**
   * The model's DECLARED maximum input length, in the model's own
   * tokenizer's tokens, taken from its published specification (the
   * `max_seq_length` a sentence-transformers checkpoint ships in
   * `sentence_bert_config.json`, or the context length the model card
   * states). Input past it is truncated by the serving stack, and no
   * OpenAI-compatible endpoint reports that it happened - the vector
   * comes back the right width, silently describing a prefix of the
   * passage.
   *
   * Declared here rather than probed: no provider in this system exposes
   * model metadata and the {@link EmbeddingProvider} contract has no
   * window field, so the only alternatives are a network round trip or
   * nothing. A model outside this table therefore has NO declared window,
   * and that is reported as a check that did not run - never as a pass.
   */
  readonly inputWindowTokens: number;
  /** True when the model is trained for cross-lingual retrieval. */
  readonly multilingual: boolean;
  /** One-line guidance shown alongside the model. */
  readonly note: string;
  /**
   * Instruction prefix for a search query (memory-write-path-integrity B2).
   * Present only for models trained with asymmetric instructions (e5). The
   * configured `embedding_prefix_query` overrides it; an explicit empty
   * string disables it.
   */
  readonly queryPrefix?: string;
  /** Instruction prefix for an indexed passage; see {@link queryPrefix}. */
  readonly passagePrefix?: string;
}

/**
 * Curated catalog. Ordered best-general-default first. These are the
 * widely-deployed open multilingual embedding models; a provider exposing
 * them under a different string can still be registered with a custom
 * `--model`.
 */
export const EMBEDDING_MODEL_PRESETS: ReadonlyArray<EmbeddingModelPreset> = Object.freeze([
  {
    model: "intfloat/multilingual-e5-small",
    label: "multilingual-e5-small",
    dimension: 384,
    // sentence_bert_config.json: max_seq_length 512; the model card states
    // inputs longer than 512 tokens are truncated.
    inputWindowTokens: 512,
    multilingual: true,
    note: "Small, fast, strong multilingual default. Prefix inputs with 'query:'/'passage:'.",
    queryPrefix: E5_QUERY_PREFIX,
    passagePrefix: E5_PASSAGE_PREFIX,
  },
  {
    model: "BAAI/bge-m3",
    label: "bge-m3",
    dimension: 1024,
    // Model card: multi-granularity, input lengths up to 8192 tokens.
    inputWindowTokens: 8192,
    multilingual: true,
    note: "High-quality multilingual, 100+ languages. Larger vectors, higher cost.",
  },
  {
    model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    label: "paraphrase-multilingual-MiniLM-L12-v2",
    dimension: 384,
    // sentence_bert_config.json: max_seq_length 128. The narrowest window
    // in this table by a wide margin - the underlying encoder accepts
    // more, the shipped sentence-transformers configuration does not.
    inputWindowTokens: 128,
    multilingual: true,
    note: "Compact multilingual paraphrase model; good latency/quality balance.",
  },
  {
    model: "Alibaba-NLP/gte-multilingual-base",
    label: "gte-multilingual-base",
    dimension: 768,
    // Model card: long-context encoder, up to 8192 tokens.
    inputWindowTokens: 8192,
    multilingual: true,
    note: "Balanced multilingual retrieval model with long context.",
  },
  {
    model: "sentence-transformers/LaBSE",
    label: "LaBSE",
    dimension: 768,
    // sentence_bert_config.json: max_seq_length 256 (the sentence-transformers
    // port caps below the 512 the underlying BERT encoder allows).
    inputWindowTokens: 256,
    multilingual: true,
    note: "109-language sentence embeddings; strong cross-lingual alignment.",
  },
  {
    model: "BAAI/bge-small-zh-v1.5",
    label: "bge-small-zh-v1.5",
    dimension: 512,
    // sentence_bert_config.json: max_seq_length 512, matching the BERT
    // encoder's max_position_embeddings. Not the same number as the
    // embedding width above, which is 512 by coincidence.
    inputWindowTokens: 512,
    multilingual: false,
    note: "Chinese-optimized small model; pick when the vault is predominantly zh.",
  },
]);

/** The recommended general-purpose default model string. */
export const RECOMMENDED_EMBEDDING_MODEL: string = EMBEDDING_MODEL_PRESETS[0]!.model;

/** Look up a preset by exact model string (null when not curated). */
export function findEmbeddingPreset(model: string): EmbeddingModelPreset | null {
  return EMBEDDING_MODEL_PRESETS.find((p) => p.model === model) ?? null;
}

/**
 * The input window declared for `model`, or `null` when this table does
 * not declare one.
 *
 * `null` means UNKNOWN, and every caller must treat it as such. It is
 * deliberately NOT the shape {@link pricePerMillionTokens} uses, which
 * answers 0 for an unlisted model so the cost gate can never falsely
 * block: an unknown price is safe to treat as free because the
 * consequence of the fallback is that a gate declines to fire. An unknown
 * window has the opposite polarity - treating it as "fits" would report a
 * passing check for a condition nobody measured, which is the misleading
 * silence this census exists to remove.
 *
 * Structural lookup by exact model string only. There is no family
 * heuristic here on purpose: `e5` prefixes are a property of the
 * INSTRUCTION FORMAT and are safe to infer, while a window is a number
 * that differs between checkpoints of one family (512 for
 * multilingual-e5-small, 128 for a MiniLM sentence-transformers port),
 * so inferring one from a name would invent the value.
 */
export function declaredInputWindowTokens(model: string | null): number | null {
  if (model === null) return null;
  return findEmbeddingPreset(model)?.inputWindowTokens ?? null;
}

/**
 * Structural e5-family detection (memory-write-path-integrity B2). Matches the
 * `e5` token wherever it appears delimited by `/` or `-` in the model id
 * (`intfloat/e5-large-v2`, `intfloat/multilingual-e5-small`), so a custom e5
 * model string not in the curated catalog still gets the instruction-prefix
 * defaults. Keys off the model id structure, never the prose note.
 */
export function isE5FamilyModel(model: string | null): boolean {
  if (!model) return false;
  return /(^|[/-])e5([/-]|$)/i.test(model);
}

/**
 * The passage prefix the CONFIGURED BACKEND will actually prepend to an
 * indexed chunk before the provider counts a token.
 *
 * Not the same question as {@link resolveEmbeddingPrefixes}, which
 * answers what the configuration asks for. Only `openai-compat`
 * implements the instruction-prefix contract (`prefixFor` in
 * `openai-compat.ts`); ZeroEntropy's `embed` takes no kind and sends the
 * raw text, the local embedder hashes n-grams over it, and the null
 * provider sends nothing at all. A census that subtracted a configured
 * prefix from a backend that never sends one would report an overflow
 * nobody can hit.
 *
 * The switch is exhaustive over {@link EmbeddingProviderName} with no
 * default arm, so adding a backend fails to compile here rather than
 * silently inheriting "sends no prefix".
 */
export function passagePrefixSentByProvider(
  provider: EmbeddingProviderName,
  configuredPassagePrefix: string | undefined,
): string {
  switch (provider) {
    case "openai-compat":
      // Exactly `OpenAICompatProvider.prefixFor("passage")`: an absent
      // configured prefix is no prefix, an empty one is disabled.
      return configuredPassagePrefix ?? "";
    case "zeroentropy":
    case "local":
    case "disabled":
      return "";
  }
}

/** The prefix pair active for an embed run, after preset + config resolution. */
export interface ResolvedEmbeddingPrefixes {
  readonly queryPrefix: string;
  readonly passagePrefix: string;
}

/**
 * Resolve the active query/passage instruction prefixes
 * (memory-write-path-integrity B2). Precedence per kind: an explicit config
 * override (including an empty string, which disables the prefix) wins;
 * otherwise the curated preset field; otherwise the structural e5 default;
 * otherwise no prefix. A `null` override means "not configured" and falls
 * through; an empty-string override means "explicitly disabled".
 */
export function resolveEmbeddingPrefixes(
  model: string | null,
  queryOverride: string | null,
  passageOverride: string | null,
): ResolvedEmbeddingPrefixes {
  const preset = model ? findEmbeddingPreset(model) : null;
  const e5 = isE5FamilyModel(model);
  const queryDefault = preset?.queryPrefix ?? (e5 ? E5_QUERY_PREFIX : "");
  const passageDefault = preset?.passagePrefix ?? (e5 ? E5_PASSAGE_PREFIX : "");
  return {
    queryPrefix: queryOverride ?? queryDefault,
    passagePrefix: passageOverride ?? passageDefault,
  };
}
