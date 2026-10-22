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
 * is a decision the operator made. The fail-closed decline is for SPEND
 * surfaces - nothing may be sent on a record nobody read - while
 * {@link ProviderConsent.unreadableReason} lets a diagnostic report the
 * same arm as unmeasured rather than as the operator's decision, and the
 * refusal names the file to repair instead of keys to flip, because a
 * record nobody has read has named no key to clear.
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

import { discoverConfig, defaultConfigPath, ConfigReadError } from "../config.ts";
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
  /**
   * Why the record could not be read, on the arm where it could not.
   * The resolver still fails closed to {@link PROVIDER_CONSENT_STATE.declined}
   * - an unreadable record is not consent - but a diagnostic that renders
   * that arm as a DECISION would pass a broken machine configuration as
   * one the operator chose. Null on every arm whose record was read.
   */
  readonly unreadableReason: string | null;
  /** The operator-facing sentence. Never empty. */
  readonly detail: string;
}

/**
 * The value that clears each decline key, keyed the way
 * {@link PROVIDER_CONSENT_KEY} is. The two keys decline INDEPENDENTLY -
 * clearing one leaves the other's decline in force - which is why the
 * re-enable sentence is built from the keys this record actually used
 * rather than naming both spellings and letting an operator clear only
 * one of them.
 */
const DECLINE_CLEARING_VALUE: Readonly<Record<string, string>> = Object.freeze({
  [PROVIDER_CONSENT_KEY.semantic]: "true",
  [PROVIDER_CONSENT_KEY.provider]: "<provider>",
});

/**
 * The sentence a refusal carries. Built from `declineKeys`, naming every
 * key that recorded THIS decline and the value that clears it, so the
 * advice is one the operator can follow to the end: following it must
 * never leave them refused by the other key. Named as a KEY, so an
 * operator reading it can search the configuration file for the spelling
 * rather than for a phrase.
 */
function reenableSentence(declineKeys: ReadonlyArray<string>): string {
  const clears = declineKeys.flatMap((key) => {
    const value = DECLINE_CLEARING_VALUE[key];
    return value === undefined ? [] : [`${key}=${value}`];
  });
  return `re-enable it with ${clears.join(" or ")}`;
}

/**
 * The advice an UNREADABLE record carries instead of a re-enable
 * sentence: an unreadable record named no key, so there is no key to
 * clear. The repair is the record itself, and the sentence names the
 * file it lives in.
 */
function repairRecordSentence(configPath: string): string {
  return `repair the configuration file at ${configPath}`;
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

/** A declined consent whose record was read, with the keys that did it. */
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
    unreadableReason: null,
    detail:
      `provider consent declined: no embedding provider will be contacted. ` +
      `${reason}${declineSpellingsSentence()}${recorded}. ` +
      `${reenableSentence(declineKeys)}.`,
  });
}

/**
 * A declined consent whose record could not be READ. Same fail-closed
 * state as {@link declined}, but no key is named - the record named none
 * - and the advice is a repair of the file, not a key to flip: a
 * re-enable sentence would be advice about a record nobody has read.
 * `unreadableReason` is what lets a diagnostic report this arm as
 * unmeasured rather than as an operator's decision.
 */
function declinedUnreadable(
  capability: SemanticCapability | null,
  unreadableReason: string,
  configPath: string,
): ProviderConsent {
  return Object.freeze({
    state: PROVIDER_CONSENT_STATE.declined,
    capability,
    declineKeys: Object.freeze([]),
    reenableKeys: PROVIDER_CONSENT_REENABLE_KEYS,
    unreadableReason,
    detail:
      `provider consent declined: no embedding provider will be contacted. ` +
      `The provider-consent record could not be read (${unreadableReason}), and an ` +
      `unreadable record is not consent. ${declineSpellingsSentence()}. ` +
      `${repairRecordSentence(configPath)}.`,
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
  // exactly what the configuration reader refuses to paper over. The
  // reason rides on the verdict, so a diagnostic can report this arm as
  // unmeasured rather than as a decision the operator made.
  let config: Readonly<Record<string, string>>;
  try {
    config = request.configPath === null ? {} : discoverConfig(request.configPath).data;
  } catch (e) {
    const reason =
      e instanceof ConfigReadError
        ? "the config file exists but could not be read"
        : e instanceof Error
          ? e.message
          : String(e);
    return declinedUnreadable(capability, reason, request.configPath ?? defaultConfigPath());
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
    unreadableReason: null,
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
