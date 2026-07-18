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
    multilingual: true,
    note: "Small, fast, strong multilingual default. Prefix inputs with 'query:'/'passage:'.",
    queryPrefix: E5_QUERY_PREFIX,
    passagePrefix: E5_PASSAGE_PREFIX,
  },
  {
    model: "BAAI/bge-m3",
    label: "bge-m3",
    dimension: 1024,
    multilingual: true,
    note: "High-quality multilingual, 100+ languages. Larger vectors, higher cost.",
  },
  {
    model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    label: "paraphrase-multilingual-MiniLM-L12-v2",
    dimension: 384,
    multilingual: true,
    note: "Compact multilingual paraphrase model; good latency/quality balance.",
  },
  {
    model: "Alibaba-NLP/gte-multilingual-base",
    label: "gte-multilingual-base",
    dimension: 768,
    multilingual: true,
    note: "Balanced multilingual retrieval model with long context.",
  },
  {
    model: "sentence-transformers/LaBSE",
    label: "LaBSE",
    dimension: 768,
    multilingual: true,
    note: "109-language sentence embeddings; strong cross-lingual alignment.",
  },
  {
    model: "BAAI/bge-small-zh-v1.5",
    label: "bge-small-zh-v1.5",
    dimension: 512,
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
