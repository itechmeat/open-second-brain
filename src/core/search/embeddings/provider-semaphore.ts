/**
 * Process-scoped outbound-request ceilings for the HTTP embedding
 * providers (nothing-runs-unwatched, U4).
 *
 * INVARIANT: across every concurrent `embed()` call in this process, at
 * most `embedding_concurrency` embedding requests are in flight against
 * one resolved provider endpoint.
 *
 * Each provider used to build `new Semaphore(config.concurrency)` INSIDE
 * `embed()`, so the configured ceiling bounded one call rather than the
 * process: two overlapping calls put `2 x embedding_concurrency` requests
 * on the wire. The indexer happens to await its calls one at a time
 * (`search/indexer.ts`), so the over-subscription was latent - but that
 * serialisation is the indexer's own property and no other caller
 * inherits it, and a ceiling that holds only for one caller is not a
 * ceiling.
 *
 * ## What the key is, and why
 *
 * The canonical embedding signature paired with the resolved request URL,
 * encoded as a JSON 2-tuple so no separator can collide with a provider
 * name, a model name, or a URL.
 *
 *   - {@link embeddingSignature} is this layer's single statement of "the
 *     same embedding configuration", already shared by the provider
 *     registry, the cost gate, and the store's corpus fingerprint. A
 *     ceiling keyed on anything else would be a second, drifting
 *     definition of provider sameness.
 *   - The endpoint URL is paired with it because the signature carries no
 *     host. `text-embedding-3-small` at api.openai.com and the same model
 *     name served by a local runtime are two remote hosts with two rate
 *     budgets; one shared ceiling would throttle each on the other's
 *     traffic.
 *   - The identity is built from the CONFIGURED dimension, never from
 *     `provider.dimension`. Both providers LEARN their dimension from the
 *     first response when `embedding_dimension` is unset, so a
 *     live-dimension key would move a provider from one ceiling to
 *     another mid-run and briefly double the in-flight budget.
 *   - The API key is deliberately absent. The openai-compat provider
 *     rotates probe keys on a 401/403 in the middle of a call; a
 *     key-bearing identity would hop budgets at exactly the moment the
 *     provider is already under stress, and it would park a secret in a
 *     process-lived map key.
 *
 * ## Scope
 *
 * The ceiling covers the batch traffic of `embed()`. A provider's
 * `ping()` issues one pre-flight probe outside it, deliberately: a
 * readiness check that queued behind an indexing run would report a
 * timeout about the queue rather than about the endpoint.
 */

import type { ResolvedEmbeddingConfig } from "../types.ts";
import { SearchError } from "../types.ts";
import { Semaphore } from "./http-util.ts";
import { embeddingSignature } from "./signature.ts";
import type { EmbeddingIdentity } from "./signature.ts";

const ceilings = new Map<string, Semaphore>();

/**
 * The registry key for one provider endpoint: see the module docblock for
 * what each half contributes. `endpoint` is the fully resolved request
 * URL, not the configured base URL, so two providers that map the same
 * base to different paths stay distinct.
 */
export function providerCeilingKey(
  provider: string,
  config: ResolvedEmbeddingConfig,
  endpoint: string,
): string {
  const identity: EmbeddingIdentity = {
    provider,
    model: config.model,
    dimension: config.dimension,
  };
  return JSON.stringify([embeddingSignature(identity), endpoint]);
}

/**
 * The one semaphore that bounds `key`, creating it on first use.
 *
 * Two live configurations that disagree on the ceiling for a single
 * endpoint are refused rather than reconciled. Keeping the first-seen
 * limit would leave the second caller believing a bound is in force that
 * is not, and a semaphore's permit count cannot be widened or narrowed
 * under holders without breaking the invariant for the requests already
 * in flight. The refusal names `embedding_concurrency` because that is
 * the key the operator changes; the remedy is to make the two
 * configurations agree, or to run them in separate processes.
 */
export function providerSemaphore(key: string, limit: number): Semaphore {
  const existing = ceilings.get(key);
  if (existing === undefined) {
    const created = new Semaphore(limit);
    ceilings.set(key, created);
    return created;
  }
  if (existing.limit !== limit) {
    throw new SearchError(
      "INVALID_INPUT",
      `embedding_concurrency disagrees for ${key}: this process already bounds it at ` +
        `${existing.limit}, and a second configuration asks for ${limit}`,
    );
  }
  return existing;
}

/**
 * Test-only: drop every ceiling so a suite starts from an empty process.
 * The leading underscore is this repo's marker for a test-only export
 * (`store-exit.ts`, `sync-lockfile.ts`), which is exactly what the rule
 * below flags.
 */
// oxlint-disable-next-line no-underscore-dangle
export function _resetProviderCeilingsForTests(): void {
  ceilings.clear();
}
