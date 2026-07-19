/**
 * Seam 2 of the knowledge-intake-and-consolidation wave (R1, t_1dcbf352):
 * the keyed external-fetch helper shared by the Brave provider, the Tavily
 * provider, and the full-page extract step.
 *
 * Responsibilities kept deliberately small (KISS):
 *   - env gate: a `null` API key makes every call a typed `disabled` error,
 *     so a keyless caller behaves byte-identically to doing nothing;
 *   - auth: `Authorization: Bearer <key>` by default, or a named header for
 *     APIs that carry the key elsewhere (Brave's `X-Subscription-Token`);
 *   - typed errors: network, auth, http, and payload failures are distinct
 *     {@link ExternalFetchError} kinds so a caller can carry them in a report
 *     instead of inventing content;
 *   - a shared response cache keyed by the NORMALIZED request (method, url,
 *     sorted query, body) - never by the key, so a credential can never leak
 *     into a cache key.
 *
 * The transport is an injected seam so the whole module is unit-testable with
 * no network. The real transport ({@link createFetchTransport}) is a thin
 * `fetch` wrapper built only by callers that actually reach the network.
 *
 * Key hygiene: the helper never logs, and every composed error message is run
 * through the shared redactor with the key as a literal, so even an upstream
 * error string that happens to embed the key is scrubbed before it surfaces.
 */

import { redactRawOutput } from "../../redactor.ts";

/** Distinct failure kinds a keyed fetch can produce. */
export type ExternalFetchErrorKind = "disabled" | "network" | "auth" | "http" | "payload";

/** A typed failure of a keyed external fetch. Carries the HTTP status when one exists. */
export class ExternalFetchError extends Error {
  readonly kind: ExternalFetchErrorKind;
  readonly status: number | null;

  constructor(kind: ExternalFetchErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ExternalFetchError";
    this.kind = kind;
    this.status = status;
  }
}

export type ExternalFetchMethod = "GET" | "POST";

/** Auth scheme applied to the request. Bearer is the default and primary. */
export type ExternalFetchAuth =
  | { readonly scheme: "bearer" }
  | { readonly scheme: "header"; readonly header: string };

export interface ExternalFetchRequest {
  readonly url: string;
  /** Defaults to GET. */
  readonly method?: ExternalFetchMethod;
  /** Query parameters, appended in a deterministic (sorted) order. */
  readonly query?: Readonly<Record<string, string>>;
  /** JSON request body for POST calls. */
  readonly body?: unknown;
  /** Auth scheme; defaults to Bearer. */
  readonly auth?: ExternalFetchAuth;
  /** Response shape to parse; defaults to json. */
  readonly accept?: "json" | "text";
}

/** Minimal response shape the transport must return. */
export interface ExternalFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Transport seam - the single call the helper makes. Injected in tests. */
export interface ExternalFetchTransport {
  (input: {
    readonly url: string;
    readonly method: ExternalFetchMethod;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | null;
  }): Promise<ExternalFetchResponse>;
}

/** A response cache keyed by the normalized request. Keys never carry the API key. */
export interface ResponseCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}

/** An in-memory {@link ResponseCache}. Suitable for one process run. */
export function createMemoryResponseCache(): ResponseCache {
  const store = new Map<string, unknown>();
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

export interface KeyedFetchConfig {
  /** API key; `null` disables the helper - every call is a typed `disabled` error. */
  readonly apiKey: string | null;
  readonly transport: ExternalFetchTransport;
  /** Optional shared response cache keyed by the normalized request. */
  readonly cache?: ResponseCache;
}

/** Stable stringify with sorted object keys, for deterministic cache keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

/** Query string in deterministic (sorted-key) order. */
function sortedQuery(query: Readonly<Record<string, string>> | undefined): string {
  if (query === undefined) return "";
  return Object.keys(query)
    .toSorted()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key]!)}`)
    .join("&");
}

/**
 * Deterministic cache key for a request. Built ONLY from the accept type,
 * method, url, sorted query, and body - never from the API key or auth headers
 * - so no credential can leak into a cache key or the paths derived from one.
 * The accept type is part of the key so a shared cache can never serve a JSON
 * value where text was expected (or vice versa).
 */
export function normalizeRequestKey(req: ExternalFetchRequest): string {
  const accept = req.accept ?? "json";
  const method = req.method ?? "GET";
  const query = sortedQuery(req.query);
  const body = req.body === undefined ? "" : stableStringify(req.body);
  return `${accept} ${method} ${req.url}?${query}#${body}`;
}

function buildUrl(req: ExternalFetchRequest): string {
  const query = sortedQuery(req.query);
  if (query.length === 0) return req.url;
  return req.url.includes("?") ? `${req.url}&${query}` : `${req.url}?${query}`;
}

function buildHeaders(apiKey: string, req: ExternalFetchRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = req.auth ?? { scheme: "bearer" };
  if (auth.scheme === "bearer") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    headers[auth.header] = apiKey;
  }
  if ((req.method ?? "GET") === "POST") headers["content-type"] = "application/json";
  headers["accept"] = req.accept === "text" ? "text/plain, text/html" : "application/json";
  return headers;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Perform a keyed external fetch through the injected transport. Enforces the
 * env gate, applies auth, consults and populates the cache, and maps every
 * failure to a typed {@link ExternalFetchError}. The API key is redacted from
 * any error message it composes.
 */
export async function keyedFetch(
  config: KeyedFetchConfig,
  req: ExternalFetchRequest,
): Promise<unknown> {
  const key = config.apiKey;
  if (key === null || key.trim().length === 0) {
    throw new ExternalFetchError("disabled", "external fetch is disabled: no API key configured");
  }

  const cacheKey = normalizeRequestKey(req);
  if (config.cache !== undefined) {
    const hit = config.cache.get(cacheKey);
    if (hit !== undefined) return hit;
  }

  const method = req.method ?? "GET";
  const headers = buildHeaders(key, req);
  const body = method === "POST" && req.body !== undefined ? JSON.stringify(req.body) : null;

  const redact = (message: string): string => redactRawOutput(message, { literals: [key] });

  let res: ExternalFetchResponse;
  try {
    res = await config.transport({ url: buildUrl(req), method, headers, body });
  } catch (err) {
    throw new ExternalFetchError("network", redact(`network failure: ${messageOf(err)}`));
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ExternalFetchError(
        "auth",
        `authentication failed with HTTP ${res.status}`,
        res.status,
      );
    }
    throw new ExternalFetchError("http", `request failed with HTTP ${res.status}`, res.status);
  }

  let value: unknown;
  try {
    value = req.accept === "text" ? await res.text() : await res.json();
  } catch (err) {
    throw new ExternalFetchError(
      "payload",
      redact(`response payload was not valid: ${messageOf(err)}`),
    );
  }

  if (config.cache !== undefined) config.cache.set(cacheKey, value);
  return value;
}

/**
 * The real `fetch`-backed transport. Built only by callers that reach the
 * network; never constructed in tests, so no test path touches the network.
 */
export function createFetchTransport(): ExternalFetchTransport {
  return async (input) => {
    const res = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body !== null ? { body: input.body } : {}),
    });
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json() as Promise<unknown>,
      text: () => res.text(),
    };
  };
}
