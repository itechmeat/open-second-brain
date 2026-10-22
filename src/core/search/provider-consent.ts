/**
 * The provider-consent resolver: what the operator's configuration says
 * about the embedding provider, and whether they DECLINED it
 * (write-honesty-egress-consent, Lane F).
 *
 * ## The defect this module exists for
 *
 * An operator who wrote `search_semantic_enabled: false` and an operator
 * who never configured semantic search at all reached the SAME capability
 * tier, so every surface reported the same sentence for two opposite
 * situations: one of them a decision, the other an absence. The
 * distinction is not cosmetic - "the provider is off" and "the operator
 * said no" have different repairs, and a surface that cannot tell them
 * apart cannot tell an operator which one they are looking at.
 *
 * ## What this module is NOT
 *
 * It is not a third "off" spelling beside the capability tier. The tier
 * (`./capability-tier.ts`) still answers what the configuration can do,
 * and this resolver CARRIES that tier rather than computing a second one:
 * {@link ProviderConsent.capability} is the shared resolver's answer, and
 * the consent adds exactly one fact beside it - whether a decline was
 * written down. A configuration sits on one rung of the shared ladder and
 * the consent is an annotation of that rung, never a rival ladder.
 *
 * The import-cycle ratchet is what limits the home: this module sits
 * BESIDE the capability tier rather than above it, and it reads the
 * operator's machine configuration directly (`../config.ts`) rather than
 * reaching for the vault configuration, whose loader sits above the search
 * layer and would close a loop. The cost of that choice is stated rather
 * than hidden: the resolver answers for the MACHINE's configuration, which
 * is where the two decline spellings live.
 *
 * ## The fail-closed arm
 *
 * A consent record that cannot be read, and a consent value that cannot
 * be parsed, both resolve to DECLINED. Reading either as "unset" would
 * turn a broken record back into a silent default - the same defect the
 * configuration reader itself refuses elsewhere ("an unreadable config is
 * not consent to print host paths", `src/mcp/vault-path-field.ts`). The
 * default `search_semantic_enabled` is `false`, so "unset" and "off" are
 * the same configuration; a record that cannot be read must not be allowed
 * to look like a record that says nothing, because only one of those two
 * is a decision the operator made.
 *
 * ## The two witnesses of a decline
 *
 *   1. `search_semantic_enabled=false` - the switch, in the config file
 *      or in `OPEN_SECOND_BRAIN_SEARCH_SEMANTIC`.
 *   2. `embedding_provider=disabled` - the provider name, in the config
 *      file or in `OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER`.
 *
 * Both are READINGS OF THE RECORD, and nothing else is. The resolved
 * configuration is deliberately NOT a third witness even though it names
 * the sentinel provider whenever the record does: a resolved
 * `provider: "disabled"` is the record seen through the resolver, and
 * treating it as an independent witness would let a configuration that
 * was assembled rather than read - a fixture, an override - claim a
 * decision the operator never wrote down. The record is the only place a
 * decision lives.
 *
 * ## Why there is no membership list and no guard
 *
 * The verdict-vocabulary census enrols a vocabulary by its four pieces -
 * a frozen object, a derived union, a membership list and a guard that
 * takes `unknown`. The states here never cross a string boundary: they
 * are compared in-process and never persisted, never put on a wire and
 * never read back off disk, so a guard that policed a round trip through
 * a string would have nothing to police. The two pieces that earn their
 * place - the frozen object and the derived union - are what ship.
 */

import { discoverConfig } from "../config.ts";
import { envOrConfig, parseBool } from "../validate.ts";
import { resolveSemanticCapability, type SemanticCapability } from "./capability-tier.ts";
import type { ResolvedEmbeddingConfig } from "./types.ts";

/**
 * The two consent states. Not a third member for "unknown": an unreadable
 * record resolves to {@link PROVIDER_CONSENT_STATE.declined}, because a
 * record that cannot be read is not a record of consent.
 */
export const PROVIDER_CONSENT_STATE = Object.freeze({
  /** The operator wrote no decision about the provider. */
  unset: "unset",
  /** The operator wrote a decline, or the record could not be read. */
  declined: "declined",
} as const);

export type ProviderConsentState =
  (typeof PROVIDER_CONSENT_STATE)[keyof typeof PROVIDER_CONSENT_STATE];

/**
 * The machine-configuration keys that record a decision about the
 * embedding provider. These are the two spellings the decline has always
 * had; this module names them rather than inventing a third.
 */
export const PROVIDER_CONSENT_KEY = Object.freeze({
  /** The switch that turns the semantic lane on. */
  semantic: "search_semantic_enabled",
  /** The provider name; the sentinel value is the decline. */
  provider: "embedding_provider",
} as const);

/**
 * The environment variables that mirror {@link PROVIDER_CONSENT_KEY}. The
 * environment wins over the config file, which is the rule the search
 * configuration resolver already applies to every key it reads.
 */
export const PROVIDER_CONSENT_ENV = Object.freeze({
  semantic: "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
  provider: "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
} as const);

/**
 * The provider name that records a decline. The resolver's default
 * provider is `openai-compat`, so this value is never reached by
 * accident.
 */
export const PROVIDER_CONSENT_DECLINED_PROVIDER = "disabled";

/**
 * The keys that would re-enable a declined provider. Named in every
 * refusal, because a refusal that does not say how to undo it is a
 * sentence the operator has to look up the spelling of.
 */
export const PROVIDER_CONSENT_REENABLE_KEYS: ReadonlyArray<string> = Object.freeze([
  PROVIDER_CONSENT_KEY.semantic,
  PROVIDER_CONSENT_KEY.provider,
]);

/** What the resolver is asked to resolve. */
export interface ProviderConsentRequest {
  /**
   * The configuration file the record is read from. `undefined` reads the
   * process default path; `null` reads no file at all, which is what an
   * environment-only resolution means.
   */
  readonly configPath?: string | null;
  /** The environment, for the environment-over-config rule. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The resolved semantic configuration. Optional: the consent state does
   * not depend on it, but the capability tier does, and a caller that
   * holds one should not have to resolve the tier twice.
   */
  readonly semantic?: ResolvedEmbeddingConfig;
}

/** What the resolver concluded. */
export interface ProviderConsent {
  /** Whether a decline was recorded. */
  readonly state: ProviderConsentState;
  /**
   * The shared capability tier, when the caller supplied a resolved
   * configuration. `null` when it did not - never a second ladder.
   */
  readonly capability: SemanticCapability | null;
  /**
   * The keys that record the decline, in the order they were found. Empty
   * when the state is unset, and non-empty for every declined state whose
   * record could be read - an unreadable record names no key, because it
   * named none.
   */
  readonly declineKeys: ReadonlyArray<string>;
  /** The keys that would re-enable a declined provider. */
  readonly reenableKeys: ReadonlyArray<string>;
  /** The operator-facing sentence. Never empty. */
  readonly detail: string;
}

/**
 * The sentence a refusal carries. Named in the message as a KEY, so an
 * operator reading it can search the configuration file for the spelling
 * rather than for a phrase.
 */
function reenableSentence(): string {
  return (
    `re-enable it with ${PROVIDER_CONSENT_KEY.semantic}=true ` +
    `or ${PROVIDER_CONSENT_KEY.provider}=<provider>`
  );
}

/**
 * How a decline is WRITTEN. Both spellings are named, not only the one
 * this record used: an operator who wrote one of them and is looking at
 * a refusal that names the other needs to see that both spell the same
 * decision.
 */
function declineSpellingsSentence(): string {
  return (
    `a decline is written as ${PROVIDER_CONSENT_KEY.semantic}=false ` +
    `or ${PROVIDER_CONSENT_KEY.provider}=${PROVIDER_CONSENT_DECLINED_PROVIDER}`
  );
}

/** A declined consent, with the reason it was read that way. */
function declined(
  capability: SemanticCapability | null,
  declineKeys: ReadonlyArray<string>,
  reason: string,
): ProviderConsent {
  const recorded =
    declineKeys.length > 0 ? `; this one is recorded by ${declineKeys.join(" and ")}` : "";
  return Object.freeze({
    state: PROVIDER_CONSENT_STATE.declined,
    capability,
    declineKeys: Object.freeze([...declineKeys]),
    reenableKeys: PROVIDER_CONSENT_REENABLE_KEYS,
    detail:
      `provider consent declined: no embedding provider will be contacted. ` +
      `${reason}${declineSpellingsSentence()}${recorded}. ` +
      `${reenableSentence()}.`,
  });
}

/**
 * Resolve what the operator's configuration says about the embedding
 * provider.
 *
 * Pure with respect to the filesystem in one direction only: it READS the
 * configuration file it is given and never writes one. A record that
 * cannot be read resolves to declined rather than to unset, and a value
 * that cannot be parsed resolves to declined for the same reason.
 */
export function resolveProviderConsent(request: ProviderConsentRequest): ProviderConsent {
  const capability =
    request.semantic === undefined ? null : resolveSemanticCapability(request.semantic);
  const env = request.env ?? process.env;

  // The record. An unreadable one is a decline, never an absence: the
  // operator's settings exist and are not the ones in force, which is
  // exactly what the configuration reader refuses to paper over.
  let config: Readonly<Record<string, string>>;
  try {
    config = request.configPath === null ? {} : discoverConfig(request.configPath).data;
  } catch {
    return declined(
      capability,
      [],
      "The provider-consent record could not be read, and an unreadable record is not consent. ",
    );
  }

  const declineKeys: string[] = [];

  // The switch. An unparseable value is a decline too: the operator wrote
  // something they meant to be a decision, and reading it as "unset"
  // would silently drop it.
  const semanticRaw = envOrConfig(
    env,
    config,
    PROVIDER_CONSENT_ENV.semantic,
    PROVIDER_CONSENT_KEY.semantic,
  );
  if (semanticRaw !== null) {
    let enabled: boolean;
    try {
      enabled = parseBool(semanticRaw, false, PROVIDER_CONSENT_KEY.semantic);
    } catch {
      return declined(
        capability,
        [PROVIDER_CONSENT_KEY.semantic],
        `The provider-consent record could not be parsed, and an unparseable record is not consent. `,
      );
    }
    if (!enabled) declineKeys.push(PROVIDER_CONSENT_KEY.semantic);
  }

  // The provider name. The sentinel value is the decline; every other
  // name is a provider the operator chose.
  const providerRaw = envOrConfig(
    env,
    config,
    PROVIDER_CONSENT_ENV.provider,
    PROVIDER_CONSENT_KEY.provider,
  );
  if (
    providerRaw !== null &&
    providerRaw.trim().toLowerCase() === PROVIDER_CONSENT_DECLINED_PROVIDER
  ) {
    declineKeys.push(PROVIDER_CONSENT_KEY.provider);
  }

  if (declineKeys.length > 0) {
    return declined(capability, declineKeys, "");
  }

  return Object.freeze({
    state: PROVIDER_CONSENT_STATE.unset,
    capability,
    declineKeys: Object.freeze([]),
    reenableKeys: PROVIDER_CONSENT_REENABLE_KEYS,
    detail: "no provider-consent decision is recorded: the embedding provider was never declined.",
  });
}

/**
 * Whether the consent is a decline. A predicate rather than a comparison
 * at the call site, so the state is read the same way everywhere.
 */
export function providerConsentIsDeclined(consent: ProviderConsent): boolean {
  return consent.state === PROVIDER_CONSENT_STATE.declined;
}
