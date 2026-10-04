/**
 * Request resolution: everything the caller's options decide BEFORE any
 * store I/O - the effective knob tuple (recall profile / self-tuning), the
 * clamped limit, input validation, the semantic policy, the session focus,
 * and the two time layers (the `since`/`until` parameters and the window
 * the query text itself declares). Resolving it here means invalid input
 * fails fast, before the index is opened.
 */

import { resolveRecallProfile } from "../profiles.ts";
import {
  DEFAULT_FTS_MATCH_MODE,
  FTS_MATCH_MODES,
  isFtsMatchMode,
  type FtsMatchMode,
} from "../fts-match-mode.ts";
import { resolveSemanticPolicy, type SemanticPolicy } from "../semantic-phase.ts";
import { readActiveSessionFocus } from "../session-focus.ts";
import {
  detectTemporalIntent,
  stripTemporalDirectives,
  type TemporalIntent,
} from "../temporal-intent.ts";
import { resolveTimeRange, type ResolvedTimeRange } from "../time-range.ts";
import { applyTunedParameters, loadTunedParameters } from "../tuning-store.ts";
import { SearchError } from "../types.ts";
import type {
  ResolvedSearchConfig,
  SearchOptions,
  SearchSessionFocus,
  TunedParameters,
} from "../types.ts";

/**
 * Bounds for the public `limit` option. CLI validates against the same
 * ceiling before calling in; MCP applies its own, lower `MCP_LIMIT_MAX`
 * (token-budget conscious) - the two ceilings are deliberately different,
 * this just gives the shared one a name instead of a bare `100` literal.
 */
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 100;

const DEFAULT_LIMIT = 10;

/**
 * The default composite hybrid deadline (t_bdc24171): the sum of the two
 * named lane budgets - the 10s embedding timeout (`DEFAULTS.timeoutMs` in
 * `../index.ts`, resolved into `embedding_timeout_ms`) and the 5s rerank
 * timeout (`DEFAULT_RERANK_TIMEOUT_MS`, `../rerank/cross-encoder.ts`).
 * Written as a number rather than derived by import because the embedding
 * half is private to the config resolver this module cannot import back
 * from; the composition is pinned numerically by
 * `tests/core/search/hybrid-deadline.test.ts`, which fails when either
 * lane budget moves without this constant moving with it.
 */
export const DEFAULT_HYBRID_DEADLINE_MS = 15_000;

export interface ResolvedSearchRequest {
  /** The config with the resolved profile / tuning knobs already applied. */
  readonly config: ResolvedSearchConfig;
  /** RESIDUAL query text: the caller's query minus any time directive. */
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix: string | undefined;
  readonly policy: SemanticPolicy;
  readonly sessionFocus: SearchSessionFocus | null;
  /** One clock for every time-resolving decision in this call. */
  readonly nowMs: number;
  readonly timeRange: ResolvedTimeRange | null;
  readonly temporalIntent: TemporalIntent | null;
  /** Whether local query expansion runs for this call. */
  readonly expandActive: boolean;
  /** The resolved FTS match breadth: the caller's choice, else `all`. */
  readonly matchMode: FtsMatchMode;
  /** The applied knob tuple, or null when neither profile nor tuning fired. */
  readonly tuned: TunedParameters | null;
  /**
   * The composite wall-clock budget for this call (t_bdc24171), in ms, or
   * null when the deadline is off. Null covers the documented off switch
   * (a configured `0`) and any value that cannot bound a duration (`<= 0`,
   * non-finite) - and the ABSENT field, because the shipped default is
   * applied by the CONFIG resolver (`resolveSearchConfig`): a config that
   * still reaches this site without the field is hand-built, and a
   * hand-built config that names no deadline runs without one, which is
   * what keeps the plain keyword path clock-clean for the rank-clock
   * census (`tests/core/search/rank-clock-determinism.test.ts`).
   */
  readonly hybridDeadlineMs: number | null;
}

function assertSafePathPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  if (prefix.includes("..") || prefix.startsWith("/") || /^[A-Za-z]:/.test(prefix)) {
    throw new SearchError("INVALID_INPUT", "path_prefix escapes vault");
  }
  return prefix;
}

export function resolveSearchRequest(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): ResolvedSearchRequest {
  const rawQuery = (opts.query ?? "").trim();
  if (!rawQuery) {
    throw new SearchError("INVALID_INPUT", "missing required argument: query");
  }
  // Recall profile (Recall & Working-Memory Quality Suite, t_98c39dd6) and
  // opt-in self-tuning (t_ae973491) resolve to the SAME knob tuple, applied
  // through applyTunedParameters (which disarms selfTuningEnabled so the
  // applied config can never recurse). An explicitly selected profile is an
  // operator choice and takes precedence over the persisted grid point; with
  // no profile, behaviour is unchanged - self-tuning applies iff enabled. An
  // explicit opts.expand always wins over the resolved expansion default.
  const profileParams = opts.profile !== undefined ? resolveRecallProfile(opts.profile) : null;
  const tuned =
    profileParams ?? (config.recall.selfTuningEnabled ? loadTunedParameters(config.vault) : null);
  const resolvedConfig = tuned !== null ? applyTunedParameters(config, tuned) : config;
  const expandActive = opts.expand ?? (tuned !== null && tuned.expansion);
  const limit = Math.max(SEARCH_LIMIT_MIN, Math.min(SEARCH_LIMIT_MAX, opts.limit ?? DEFAULT_LIMIT));
  if (opts.threshold !== undefined && (!Number.isFinite(opts.threshold) || opts.threshold < 0)) {
    throw new SearchError("INVALID_INPUT", "threshold must be a finite number >= 0");
  }
  const pathPrefix = assertSafePathPrefix(opts.pathPrefix);
  const policy = resolveSemanticPolicy(resolvedConfig, opts);
  // One clock for every time-resolving decision in this call, so the hard
  // filter, the session-focus expiry and the query-declared window below
  // cannot disagree by a few milliseconds of wall-clock drift.
  const nowMs = Date.now();
  const sessionFocus =
    opts.sessionFocus === undefined
      ? readActiveSessionFocus(resolvedConfig, opts.focusSession, nowMs)
      : opts.sessionFocus;
  // Time-aware recall (recall-trust-suite): resolve since/until up front
  // so invalid input fails fast, before any store I/O.
  const timeRange =
    opts.since !== undefined || opts.until !== undefined
      ? resolveTimeRange({ since: opts.since, until: opts.until }, nowMs)
      : null;
  // Query-side temporal intent (t_58fc4720). Resolved HERE, from the raw
  // query as the caller typed it, and before any store I/O:
  //
  //   - detection must read the ORIGINAL text. Expansion rewrites the
  //     keyword lane into bare lexical terms, and the `field:value`
  //     grammar does not survive that rewrite - planning from the
  //     rewritten text saw no directive while the strip below still
  //     removed one, so a declared window was voided and its directive
  //     reached the implicit-AND keyword lane as a term nothing matches;
  //   - a malformed directive then fails as fast as `since` / `until`
  //     does, rather than after the index is opened.
  //
  // From here on the query text is the RESIDUAL text: a directive states
  // the window and is not a term, so it must not reach the keyword lane,
  // the semantic lane, the coverage gate or the evidence pack. Stripping
  // is byte-identical for a query that carries no directive.
  const temporalIntent = detectTemporalIntent(rawQuery, nowMs);
  const query = stripTemporalDirectives(rawQuery);
  if (query === "") {
    // A window with nothing to search for. Both lanes would be handed the
    // empty string - FTS short-circuits on an empty match and the semantic
    // lane embeds "" - so the honest answer is the same one the parameter
    // form gives: a window FILTERS a query, it is not a query.
    throw new SearchError(
      "INVALID_INPUT",
      "the query declares a time window and no search terms: " +
        "add the terms to look for, or pass the window as the since / until parameters",
    );
  }

  const matchMode = opts.matchMode ?? DEFAULT_FTS_MATCH_MODE;
  if (!isFtsMatchMode(matchMode)) {
    throw new SearchError(
      "INVALID_INPUT",
      `match_mode must be one of ${FTS_MATCH_MODES.join(", ")}`,
    );
  }
  // Composite hybrid deadline (t_bdc24171). The shipped default lives in
  // the config resolver; a config reaching this site WITHOUT the field is
  // hand-built, and runs with no deadline rather than with the default -
  // which is what keeps the plain keyword path clock-clean for the
  // rank-clock census. A configured 0 is the explicit off switch; anything
  // else that cannot bound a duration is off too - hand-built configs do
  // not pass the resolver's validation, so the read site never guesses
  // between "default" and "disabled".
  const hybridDeadlineMs =
    resolvedConfig.hybridDeadlineMs !== undefined &&
    Number.isFinite(resolvedConfig.hybridDeadlineMs) &&
    resolvedConfig.hybridDeadlineMs > 0
      ? resolvedConfig.hybridDeadlineMs
      : null;
  return {
    config: resolvedConfig,
    query,
    limit,
    pathPrefix,
    policy,
    sessionFocus,
    nowMs,
    timeRange,
    temporalIntent,
    expandActive,
    matchMode,
    tuned,
    hybridDeadlineMs,
  };
}
