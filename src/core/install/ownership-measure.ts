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

import { resolveTelegramBotToken } from "../config.ts";
import { pathIsInside, realpathInsideVault } from "../path-safety.ts";
import { SecretReferenceError } from "../secret-ref.ts";
import { resolveResearchPoolEnv } from "../brain/research/research.ts";
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

  // The vault-resolved configuration, not raw `process.env` alone: a key
  // env written as a `$secret:NAME` reference resolves the way the runtime
  // resolves it - the custody store of THIS vault first, the environment
  // fallback second - so a raw reference no longer counts as a configured
  // research key, and a reference that resolves nowhere surfaces the
  // resolver's named error instead of quietly yielding a pool. The
  // measurement reports that refusal as `unchecked` with the reason the
  // resolver gave: the row names the unresolved reference, which is the
  // v1.78.0 claim, now true on the live path.
  let researchRow: OutboundMeasurement;
  try {
    const research = resolveResearchPoolEnv(process.env, opts.vault);
    researchRow = present(research.braveApiKey !== null || research.tavilyApiKey !== null);
  } catch (err) {
    if (!(err instanceof SecretReferenceError)) throw err;
    researchRow = {
      state: OUTBOUND_STATE.unchecked,
      reason: `the research key could not be resolved: ${err.message}`,
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
