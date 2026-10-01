/**
 * Why a cross-encoder rerank request failed, as a closed vocabulary.
 *
 * The rerank stage degrades to the heuristic order on any request-time
 * failure, and until this module the only record of why was the provider's
 * own message inside a `rerank_degraded:` warning. A caller that wanted to
 * tell a revoked key from a dead endpoint from a flaky one had to
 * pattern-match English. The category below is computed where the failure
 * is typed - the HTTP status, the abort, the parse - and never from message
 * text, so it survives a provider rewording its errors.
 *
 * The thrown carrier, {@link RerankEndpointError}, stays a `SearchError`
 * with the unchanged `RERANK_PROVIDER_HTTP` code and the unchanged message:
 * every existing consumer of either keeps working byte for byte.
 */

import { SearchError } from "../search-error.ts";

/** The closed failure categories of a rerank request. */
export const RERANK_FAILURE_CATEGORY = Object.freeze({
  /** HTTP 401 or 403: the key is missing, wrong or not allowed this model. */
  auth: "auth",
  /** HTTP 402: the account's quota or billing is exhausted. */
  quota: "quota",
  /** HTTP 404 or 410: the endpoint or the model is gone (the decommission signal). */
  gone: "gone",
  /** Any other HTTP 4xx: the endpoint refused this request as sent. */
  rejected: "rejected",
  /**
   * HTTP 408, 429 or 5xx: the endpoint may answer later. Some vendors also
   * answer 429 for exhausted quota; the category is computed from the
   * status alone.
   */
  transient: "transient",
  /** The request outlived this build's own per-request timeout. */
  timeout: "timeout",
  /** The request never reached an answer: refused connection, DNS, TLS, redirect. */
  network: "network",
  /** The endpoint answered 2xx with a body this build cannot read as scores. */
  malformed: "malformed",
  /**
   * A failure no rerank provider typed - a provider implementation outside
   * the cross-encoder threw a plain error. Named, so it is never hidden
   * inside another category.
   */
  unclassified: "unclassified",
} as const);

/** Closed union over {@link RERANK_FAILURE_CATEGORY}. */
export type RerankFailureCategory =
  (typeof RERANK_FAILURE_CATEGORY)[keyof typeof RERANK_FAILURE_CATEGORY];

/** Membership list, from the most to the least specific operator action. */
export const RERANK_FAILURE_CATEGORIES: ReadonlyArray<RerankFailureCategory> = Object.freeze([
  RERANK_FAILURE_CATEGORY.auth,
  RERANK_FAILURE_CATEGORY.quota,
  RERANK_FAILURE_CATEGORY.gone,
  RERANK_FAILURE_CATEGORY.rejected,
  RERANK_FAILURE_CATEGORY.transient,
  RERANK_FAILURE_CATEGORY.timeout,
  RERANK_FAILURE_CATEGORY.network,
  RERANK_FAILURE_CATEGORY.malformed,
  RERANK_FAILURE_CATEGORY.unclassified,
]);

/** Narrow a string read back across a tool boundary. */
export function isRerankFailureCategory(value: unknown): value is RerankFailureCategory {
  return (
    typeof value === "string" &&
    (RERANK_FAILURE_CATEGORIES as ReadonlyArray<string>).includes(value)
  );
}

const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const QUOTA_STATUSES: ReadonlySet<number> = new Set([402]);
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);
const SERVER_ERROR_MIN = 500;

/**
 * The category of a non-2xx rerank response. Total over every status the
 * cross-encoder can see: a status that is not an auth, quota, gone or
 * retryable client status is a server error (5xx, transient) or a refusal
 * of this request (every other non-2xx, rejected).
 */
export function rerankCategoryForStatus(status: number): RerankFailureCategory {
  if (AUTH_STATUSES.has(status)) return RERANK_FAILURE_CATEGORY.auth;
  if (QUOTA_STATUSES.has(status)) return RERANK_FAILURE_CATEGORY.quota;
  if (GONE_STATUSES.has(status)) return RERANK_FAILURE_CATEGORY.gone;
  if (TRANSIENT_CLIENT_STATUSES.has(status) || status >= SERVER_ERROR_MIN) {
    return RERANK_FAILURE_CATEGORY.transient;
  }
  return RERANK_FAILURE_CATEGORY.rejected;
}

/** What a {@link RerankEndpointError} knows beyond its message. */
export interface RerankEndpointErrorOptions {
  readonly category: RerankFailureCategory;
  /** Upstream HTTP status, present only when the endpoint answered. */
  readonly status?: number;
}

/**
 * A rerank request failure with its category attached. Code and message
 * are exactly those of the untyped `SearchError` it replaces.
 */
export class RerankEndpointError extends SearchError {
  readonly category: RerankFailureCategory;
  constructor(message: string, opts: RerankEndpointErrorOptions) {
    super(
      "RERANK_PROVIDER_HTTP",
      message,
      opts.status !== undefined ? { status: opts.status } : {},
    );
    this.name = "RerankEndpointError";
    this.category = opts.category;
  }
}

/**
 * The category of any value a rerank provider threw. A typed
 * {@link RerankEndpointError} names its own; anything else was not typed
 * by a provider and says so.
 */
export function rerankCategoryForError(error: unknown): RerankFailureCategory {
  return error instanceof RerankEndpointError
    ? error.category
    : RERANK_FAILURE_CATEGORY.unclassified;
}
