/**
 * Where `search check` looked for an embedding credential (t_82c3b275).
 *
 * A `credential-missing` tier says that no key resolved. This report
 * says where the resolver looked, in its own probe order, and which
 * other registered profiles do have a key present, so an operator whose
 * key sits under another name can see it without reading the resolver.
 *
 * Three rules bound it:
 *
 *   - Names only. An env value is tested for presence and never copied,
 *     so nothing credential-shaped can leave this function.
 *   - Operator-declared names only: the config key, its env override and
 *     the env-key names of the profiles in the vault's own registry. No
 *     vendor list of well-known variable names is consulted.
 *   - It does not touch the tier. `resolveSemanticCapability` stays
 *     derived from the resolved config alone; this report is computed
 *     beside it, from an env the caller passes in explicitly.
 */

import { resolveSemanticCapability, SEMANTIC_CAPABILITY_TIER } from "../capability-tier.ts";
import {
  SearchError,
  type CredentialSourceReport,
  type ResolvedEmbeddingConfig,
} from "../types.ts";
import { envKeyList, type ProviderProfile } from "./registry.ts";

export type { CredentialSourceReport };

/** The env override of the explicit credential, which wins over the config key. */
export const EMBEDDING_KEY_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_KEY";
/** The flat config key of the explicit credential. */
export const EMBEDDING_KEY_CONFIG = "embedding_api_key";

/**
 * The explicit credential sources, in the order the resolver probes
 * them. They are consulted for every provider that needs a key, a
 * registered profile included: an explicit key wins over the profile's.
 */
export const EXPLICIT_CREDENTIAL_SOURCES: ReadonlyArray<string> = Object.freeze([
  EMBEDDING_KEY_ENV,
  EMBEDDING_KEY_CONFIG,
]);

/** Where the report reads names from, handed in by the caller rather than read from the process. */
export interface CredentialSourceContext {
  /** The registered profile the configuration names, or null for explicit config. */
  readonly activeProfile: string | null;
  readonly registry: ReadonlyArray<ProviderProfile>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CredentialSourceInput extends CredentialSourceContext {
  readonly semantic: ResolvedEmbeddingConfig;
}

function hasPresentKey(
  profile: ProviderProfile,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return envKeyList(profile.envKey).some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

/**
 * The credential-source report, or null for every tier other than
 * `credential-missing` - a configured or disabled setup has nothing to
 * explain, so its check output stays byte-identical.
 *
 * Throws `SearchError("INVALID_INPUT")` naming the profile when
 * `activeProfile` is not in `registry`: config resolution only expands a
 * registered name, so a mismatch means the caller passed two different
 * registries, and a report built on either would name the wrong sources.
 */
export function describeCredentialSources(
  input: CredentialSourceInput,
): CredentialSourceReport | null {
  const { semantic, activeProfile, registry, env } = input;
  if (resolveSemanticCapability(semantic).tier !== SEMANTIC_CAPABILITY_TIER.credentialMissing) {
    return null;
  }
  let profileKeys: ReadonlyArray<string> = [];
  if (activeProfile !== null) {
    const profile = registry.find((p) => p.name === activeProfile);
    if (profile === undefined) {
      throw new SearchError(
        "INVALID_INPUT",
        `embedding provider profile "${activeProfile}" is not in the provider registry`,
      );
    }
    profileKeys = envKeyList(profile.envKey);
  }
  return Object.freeze({
    consulted: Object.freeze([...EXPLICIT_CREDENTIAL_SOURCES, ...profileKeys]),
    presentElsewhere: Object.freeze(
      registry.filter((p) => p.name !== activeProfile && hasPresentKey(p, env)).map((p) => p.name),
    ),
  });
}
