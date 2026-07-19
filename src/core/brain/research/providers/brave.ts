/**
 * Brave web-search provider (R1, t_1dcbf352).
 *
 * Brave carries its credential in the `X-Subscription-Token` header rather
 * than a Bearer token, so this provider passes the seam-2 helper an explicit
 * header auth scheme. Results are copied verbatim from `web.results`; the
 * provider runs no model and invents nothing.
 */

import { keyedFetch, type KeyedFetchConfig } from "../external-fetch.ts";
import { asText, type ProviderSearchResult, type ResearchProvider } from "./provider.ts";

/** Env var that gates the Brave provider. */
export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
/** Stable provider name used in pool reports. */
export const BRAVE_PROVIDER_NAME = "brave";
/** Brave web-search endpoint. A named constant; never logged with a key. */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** Header Brave uses for its subscription credential. */
const BRAVE_AUTH_HEADER = "X-Subscription-Token";

function parseResults(payload: unknown): ProviderSearchResult[] {
  if (payload === null || typeof payload !== "object") return [];
  const web = (payload as Record<string, unknown>)["web"];
  if (web === null || typeof web !== "object") return [];
  const results = (web as Record<string, unknown>)["results"];
  if (!Array.isArray(results)) return [];
  const out: ProviderSearchResult[] = [];
  for (const raw of results) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = asText(record["url"]);
    if (url.length === 0) continue;
    out.push({ title: asText(record["title"]), url, snippet: asText(record["description"]) });
  }
  return out;
}

export function createBraveProvider(config: KeyedFetchConfig): ResearchProvider {
  return {
    name: BRAVE_PROVIDER_NAME,
    async search(query: string): Promise<readonly ProviderSearchResult[]> {
      const payload = await keyedFetch(config, {
        url: BRAVE_ENDPOINT,
        query: { q: query },
        auth: { scheme: "header", header: BRAVE_AUTH_HEADER },
      });
      return parseResults(payload);
    },
  };
}
