/**
 * Semantic capability tier — the one resolver for "what did the operator
 * configure" (provenance-at-the-boundary, F1).
 *
 * Four surfaces used to derive this from `ResolvedEmbeddingConfig`
 * separately: the semantic candidate lane (`semantic-phase.ts`), the
 * index run's deferred-backend explanation (`indexer.ts`), the readiness
 * probe (`../doctor-readiness.ts`), and `indexCheck` (`indexer.ts`). Four
 * copies of one ladder drift, and one of them had drifted into building
 * operator-facing sentences at the call site. They share this module now.
 *
 * ## The boundary this module sits on
 *
 * A capability tier answers WHAT THE OPERATOR CONFIGURED. The
 * {@link SearchError} codes answer WHAT A CALL ATTEMPTED AND COULD NOT
 * DO. They are not two spellings of one fact and nothing reports both for
 * one condition: a surface that refused before attempting anything
 * reports the tier, and a surface that attempted and failed throws the
 * typed error. `EMBEDDING_KEY_MISSING` therefore still belongs to the
 * explicit `--semantic` request that was refused; the implicit
 * degradation beside it reports the tier.
 *
 * Runtime facts are deliberately NOT tiers. Whether sqlite-vec loaded and
 * whether the index holds any vectors are properties of this machine and
 * this index, not of the configuration, and each already has its own
 * report (`vecLoaded()`, the store counts, `VEC_EXTENSION_UNAVAILABLE`).
 * Folding them in here would make the tier mean two things at once.
 *
 * ## Why the label lookup is async
 *
 * Every operator-facing sentence resolves a REGISTERED code through
 * `core/brain/diagnostics.ts` (the v1.40.0 advisory rail). A STATIC
 * import of that registry from `core/search/` closes a module cycle -
 * `brain/next-step.ts` -> `brain/diagnostics.ts` -> `brain/doctor.ts` ->
 * `brain/doctor/entity-checks.ts` -> `brain/entities/semantic-dedup.ts`
 * -> `search/embeddings/configured-provider.ts` -> `search/index.ts` ->
 * back into this layer - which the import-cycle ratchet fails, and
 * rightly: a cycle makes module-scope initialisation order undefined. A
 * deferred `await import` is evaluated after both modules have
 * initialised and is the sanctioned cure this tree already uses, so the
 * label lookup is async and every caller of it is already async.
 */

import type { ResolvedEmbeddingConfig } from "./types.ts";

/**
 * The configured-capability ladder. Ordered from least to most capable;
 * a configuration sits at exactly one rung.
 */
export const SEMANTIC_CAPABILITY_TIER = Object.freeze({
  /** Semantic search is switched off, or the provider is the sentinel. */
  disabled: "disabled",
  /** Switched on with a provider that needs a credential, and none resolves. */
  credentialMissing: "credential-missing",
  /** Everything the configuration must supply is supplied. */
  configured: "configured",
} as const);

export type SemanticCapabilityTier =
  (typeof SEMANTIC_CAPABILITY_TIER)[keyof typeof SEMANTIC_CAPABILITY_TIER];

/**
 * Registered diagnostic code per tier. Every one of these has an entry in
 * `DIAGNOSTIC_SIGNALS`; the codes are written as literals on both sides
 * (the same convention the CLI's `search-index-built` follows) so this
 * module stays a leaf, and a test asserts each one resolves.
 */
export const SEMANTIC_CAPABILITY_CODE = Object.freeze({
  disabled: "semantic-capability-disabled",
  credentialMissing: "semantic-capability-key-missing",
  configured: "semantic-capability-configured",
} as const);

/**
 * Registered codes for the two VECTOR-population states, which are index
 * facts rather than capability tiers and so are named apart from them:
 * `deferred` is a run that never asked for embeddings, `pending` is an
 * index holding chunks that have no vector.
 */
export const SEMANTIC_VECTOR_CODE = Object.freeze({
  deferred: "semantic-vectors-deferred",
  pending: "semantic-vectors-pending",
} as const);

/**
 * Providers that cannot embed without a credential. `local` embeds
 * offline and `disabled` embeds not at all, so neither appears.
 */
const PROVIDERS_REQUIRING_CREDENTIAL: ReadonlySet<string> = new Set([
  "openai-compat",
  "zeroentropy",
]);

/** The configured-capability verdict: one tier and its registered code. */
export interface SemanticCapability {
  readonly tier: SemanticCapabilityTier;
  /** The registered diagnostic code for {@link tier}. Always registered. */
  readonly code: string;
}

const CAPABILITY_BY_TIER: Readonly<Record<SemanticCapabilityTier, SemanticCapability>> =
  Object.freeze({
    [SEMANTIC_CAPABILITY_TIER.disabled]: Object.freeze({
      tier: SEMANTIC_CAPABILITY_TIER.disabled,
      code: SEMANTIC_CAPABILITY_CODE.disabled,
    }),
    [SEMANTIC_CAPABILITY_TIER.credentialMissing]: Object.freeze({
      tier: SEMANTIC_CAPABILITY_TIER.credentialMissing,
      code: SEMANTIC_CAPABILITY_CODE.credentialMissing,
    }),
    [SEMANTIC_CAPABILITY_TIER.configured]: Object.freeze({
      tier: SEMANTIC_CAPABILITY_TIER.configured,
      code: SEMANTIC_CAPABILITY_CODE.configured,
    }),
  });

/** True when at least one API key resolved for this configuration. */
function credentialResolves(semantic: ResolvedEmbeddingConfig): boolean {
  if ((semantic.apiKeys?.length ?? 0) > 0) return true;
  return typeof semantic.apiKey === "string" && semantic.apiKey.length > 0;
}

/**
 * Classify what the operator configured. Pure, synchronous, and derived
 * from the resolved config alone - never from `process.env`, never from
 * the index, never from a live provider.
 */
export function resolveSemanticCapability(semantic: ResolvedEmbeddingConfig): SemanticCapability {
  if (!semantic.enabled || semantic.provider === "disabled") {
    return CAPABILITY_BY_TIER[SEMANTIC_CAPABILITY_TIER.disabled];
  }
  if (PROVIDERS_REQUIRING_CREDENTIAL.has(semantic.provider) && !credentialResolves(semantic)) {
    return CAPABILITY_BY_TIER[SEMANTIC_CAPABILITY_TIER.credentialMissing];
  }
  return CAPABILITY_BY_TIER[SEMANTIC_CAPABILITY_TIER.configured];
}

/** True when the configuration cannot reach a provider as it stands. */
export function semanticCapabilityIsBlocked(capability: SemanticCapability): boolean {
  return capability.tier !== SEMANTIC_CAPABILITY_TIER.configured;
}

/**
 * The operator-facing label for a registered capability or vector code,
 * read from the diagnostics registry.
 *
 * Throws {@link UnregisteredNextStepError} for a code the registry does
 * not hold. That is deliberate: this function's whole job is to keep the
 * sentence out of the call site, and returning the code itself - or an
 * invented sentence - would put it back while reading as success.
 */
export async function semanticCapabilityLabel(code: string): Promise<string> {
  const { requireNextStep } = await import("../brain/next-step.ts");
  return requireNextStep(code).issueClass;
}
