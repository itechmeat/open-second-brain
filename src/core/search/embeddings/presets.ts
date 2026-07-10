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
