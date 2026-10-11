/**
 * The measuring half of the ownership statement.
 *
 * `ownership.ts` is pure on purpose - the statement a test asserts on is
 * the statement an operator gets - so everything that reads config, env or
 * disk for it lives here, once, for both surfaces that print it (`o2b
 * install` and the onboarding checklist). They used to measure their own
 * inputs separately, which is how one of them could gain a fact the other
 * lacked.
 *
 * Two rules hold every function below:
 *
 *   1. A check that could not run says so. Nothing here rounds a failure
 *      down to "not configured": the search config throwing on an
 *      out-of-range key used to leave the statement printing an
 *      unqualified "nothing to cancel" on the strength of a check that
 *      never happened. That case is now `unchecked` with the thrown
 *      message, and the statement prints it.
 *   2. Nothing is inferred from a provider NAME. Whether an endpoint is
 *      somebody else's is not something a transport kind can answer - an
 *      OpenAI-compatible base URL is the documented way to run Ollama on
 *      loopback - so the endpoint is resolved and printed, and the
 *      sentence says only what is true of both: this tool does not run it.
 */

import { existsSync } from "node:fs";

import { BRAVE_API_KEY_ENV, TAVILY_API_KEY_ENV } from "../brain/research/research.ts";
import { keyPath, listSecrets, storeLockedForThisProcess } from "../brain/secrets/store.ts";
import { resolveTelegramBotToken } from "../config.ts";
import { pathIsInside, realpathInsideVault } from "../path-safety.ts";
import {
  invalidSecretReferenceBody,
  isSecretReferenceValue,
  parseSecretReference,
  storeSecretName,
} from "../secret-ref.ts";
import { resolveSearchConfig } from "../search/index.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";
import {
  buildDataOwnership,
  OUTBOUND_SERVICE,
  OUTBOUND_STATE,
  SEARCH_INDEX_LOCATION,
  type DataOwnership,
  type OutboundMeasurement,
  type OutboundServiceId,
  type SearchIndexVerdict,
} from "./ownership.ts";

export interface MeasureDataOwnershipOptions {
  /** The vault as the canonical resolver answered it. */
  readonly vault: string;
  /** Config file to resolve against; the caller's own resolved path. */
  readonly configPath?: string;
  /** Targets the install registry knows, from the caller that owns the registry. */
  readonly adapterTargets: ReadonlyArray<string>;
}

/**
 * There is deliberately no `env` option.
 *
 * `resolveSearchConfig` and `resolveTelegramBotToken` read `process.env`
 * themselves, so an injected environment would reach one of the four
 * checks and not the other three - a record measured against two
 * different environments, reported as one. Tests set `process.env`
 * instead, which is the environment the statement is actually about.
 */

/**
 * Where the index resolved, and whether that is inside the vault.
 *
 * The containment test is the same two-step one every vault write goes
 * through - lexical first, then realpath - because a `.open-second-brain`
 * directory that is itself a symlink out of the vault would pass the
 * lexical half while the file lives elsewhere. A throw from the realpath
 * half is `unchecked`, never "outside": an unreadable ancestor is not
 * evidence of relocation.
 */
function measureSearchIndex(vault: string, dbPath: string): SearchIndexVerdict {
  let inside: boolean;
  try {
    inside = pathIsInside(dbPath, vault) && realpathInsideVault(dbPath, vault);
  } catch (err) {
    return {
      state: SEARCH_INDEX_LOCATION.unchecked,
      path: null,
      reason: `resolving ${dbPath} against the vault failed: ${(err as Error).message}`,
    };
  }
  return {
    state: inside ? SEARCH_INDEX_LOCATION.insideVault : SEARCH_INDEX_LOCATION.outsideVault,
    path: dbPath,
    reason: null,
  };
}

/**
 * One research key env's presence, decided from METADATA alone - never a
 * decrypt.
 *
 * A measurement is a presence check, and a presence check that decrypts
 * turns `o2b install` into a key-bearing operation: the resolver route
 * used here before answered a `$secret:NAME` reference through
 * `resolveSecretReadOnly`, so a wrapped (locked) store threw the named
 * locked refusal out of the statement and aborted install and
 * onboarding. The probe below therefore reads the custody store's name
 * set (normalized the way the store normalizes at set time) joined with
 * the environment fallback, and never touches ciphertext:
 *
 *   - a plain value answers as before;
 *   - a reference the store holds answers `configured` - the store
 *     normalizes names, so the probe normalizes the reference body the
 *     same way - unless the store cannot answer a key-bearing read right
 *     now (locked, or its keyfile missing while entries survive), which
 *     is `unchecked` with that reason rather than a guess in either
 *     direction;
 *   - a reference the store does not hold answers from the environment
 *     leg (case-sensitive, as the resolver answers it), and a reference
 *     that resolves nowhere keeps a refusal that names it - the v1.78.0
 *     claim - as `unchecked`.
 *
 * Note the vault-configured half this keeps from the earlier fix: the
 * raw reference no longer counts as a configured key. The wiring at the
 * research call site itself remains open (PR #248 review M12); this
 * measurement never decrypts (PR #248 review M11).
 */
function researchKeyPresence(
  envValue: string | undefined,
  vault: string,
): { readonly present: boolean; readonly refusal: string | null } {
  const trimmed = envValue?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { present: false, refusal: null };
  if (!isSecretReferenceValue(trimmed)) return { present: true, refusal: null };
  const ref = parseSecretReference(trimmed);
  if (ref === null) {
    const body = invalidSecretReferenceBody(trimmed) ?? trimmed;
    return {
      present: false,
      refusal: `the research key reference "$secret:${body}" is not a spellable reference and resolves to an error at use time`,
    };
  }
  const storeHolds = listSecrets(vault).some((meta) => meta.name === storeSecretName(ref.name));
  if (storeHolds) {
    // Store first, as the resolver answers it: a held name never falls
    // back to the environment, so the store's readability decides.
    if (storeLockedForThisProcess(vault)) {
      return {
        present: false,
        refusal: `the research key reference "$secret:${ref.name}" names a store entry, but the secret store is locked (the keyfile is passphrase-wrapped), so the presence check cannot confirm the key without decrypting; unlock the store for this process to complete the statement`,
      };
    }
    if (!existsSync(keyPath(vault))) {
      return {
        present: false,
        refusal: `the research key reference "$secret:${ref.name}" names a store entry, but the secret store's keyfile is missing, so the stored key cannot be confirmed; restore the keyfile to complete the statement`,
      };
    }
    return { present: true, refusal: null };
  }
  if (process.env[ref.name]) return { present: true, refusal: null };
  return {
    present: false,
    refusal: `the research key reference "$secret:${ref.name}" resolves nowhere: no custody store entry, no environment fallback`,
  };
}

/** `configured` with the endpoint when there is one, `absent` otherwise. */
function present(configured: boolean, endpoint?: string | null): OutboundMeasurement {
  if (!configured) return { state: OUTBOUND_STATE.absent };
  return {
    state: OUTBOUND_STATE.configured,
    ...(endpoint === null || endpoint === undefined || endpoint === ""
      ? {}
      : { endpoint: endpoint }),
  };
}

/** The two integrations the search config decides. */
function searchOutbound(search: ResolvedSearchConfig): {
  readonly embedding: OutboundMeasurement;
  readonly rerank: OutboundMeasurement;
} {
  const semantic = search.semantic;
  // BOTH halves are required, and the enabled half is not decoration:
  // `embedding_provider` defaults to `openai-compat` whether or not
  // semantic search was ever turned on, so a provider-only test announced
  // a configured cloud endpoint on a default install that has never
  // computed an embedding. Nothing leaves this machine until the feature
  // is enabled. Where it then goes is the base URL, which is printed
  // rather than judged - a loopback endpoint is a third party by no
  // definition worth printing.
  const embeddingNetworked =
    semantic.enabled && semantic.provider !== "local" && semantic.provider !== "disabled";
  // The local rerank kind runs the bundled offline model, so only the
  // `openai-compat` and `decision-model` kinds reach an endpoint. The
  // decision-model kind is enabled here only while its config is active,
  // and its endpoint is the decision model's base URL.
  const rerankNetworked = search.rerank.enabled && search.rerank.kind !== "local";
  const rerankEndpoint =
    search.rerank.kind === "decision-model"
      ? (search.rerank.decisionModel?.baseUrl ?? null)
      : search.rerank.baseUrl;
  return {
    embedding: present(embeddingNetworked, semantic.baseUrl),
    rerank: present(rerankNetworked, rerankEndpoint),
  };
}

/**
 * Measure every input the statement needs, then compose it.
 *
 * The search config carries two of the four outbound answers AND the index
 * path, so one failure to resolve it leaves three facts unestablished -
 * all three are reported as such rather than defaulted.
 */
export function measureDataOwnership(opts: MeasureDataOwnershipOptions): DataOwnership {
  let search: ResolvedSearchConfig | null = null;
  let searchFailure = "";
  try {
    search = resolveSearchConfig({
      vault: opts.vault,
      ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
    });
  } catch (err) {
    searchFailure = `the search config would not resolve: ${(err as Error).message}`;
  }

  const unchecked: OutboundMeasurement = {
    state: OUTBOUND_STATE.unchecked,
    reason: searchFailure,
  };
  const fromSearch =
    search === null ? { embedding: unchecked, rerank: unchecked } : searchOutbound(search);

  let telegram: OutboundMeasurement;
  try {
    telegram = present(resolveTelegramBotToken(opts.configPath) !== null);
  } catch (err) {
    telegram = {
      state: OUTBOUND_STATE.unchecked,
      reason: `the bot token could not be read: ${(err as Error).message}`,
    };
  }

  // The vault-resolved configuration, metadata only: a key env written as
  // a `$secret:NAME` reference answers through the custody store of THIS
  // vault (name set first, environment fallback second), so a raw
  // reference no longer counts as a configured research key, and a
  // reference that resolves nowhere surfaces as `unchecked` with a reason
  // naming the unresolved reference - the v1.78.0 claim. Nothing here
  // decrypts: the store's name set is the evidence, and a store the
  // process cannot read right now (locked, keyfile missing) is reported
  // as `unchecked` with that reason instead of aborting the statement.
  let researchRow: OutboundMeasurement;
  try {
    const brave = researchKeyPresence(process.env[BRAVE_API_KEY_ENV], opts.vault);
    const tavily = researchKeyPresence(process.env[TAVILY_API_KEY_ENV], opts.vault);
    const refusals = [brave, tavily].filter((k) => !k.present && k.refusal !== null);
    if (refusals.length > 0) {
      researchRow = {
        state: OUTBOUND_STATE.unchecked,
        reason: refusals.map((k) => k.refusal).join("; "),
      };
    } else {
      researchRow = present(brave.present || tavily.present);
    }
  } catch (err) {
    researchRow = {
      state: OUTBOUND_STATE.unchecked,
      reason: `the research key could not be read: ${(err as Error).message}`,
    };
  }

  const outbound: Record<OutboundServiceId, OutboundMeasurement> = {
    [OUTBOUND_SERVICE.embedding]: fromSearch.embedding,
    [OUTBOUND_SERVICE.rerank]: fromSearch.rerank,
    [OUTBOUND_SERVICE.telegram]: telegram,
    [OUTBOUND_SERVICE.research]: researchRow,
  };

  return buildDataOwnership({
    vault: opts.vault,
    searchIndex:
      search === null
        ? { state: SEARCH_INDEX_LOCATION.unchecked, path: null, reason: searchFailure }
        : measureSearchIndex(opts.vault, search.dbPath),
    adapterTargets: opts.adapterTargets,
    outbound,
  });
}
