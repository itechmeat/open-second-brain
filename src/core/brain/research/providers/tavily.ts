/**
 * Tavily web-search provider (R1, t_1dcbf352).
 *
 * Tavily authenticates with a Bearer token (the seam-2 helper default) and
 * takes the query in a POST JSON body. Results are copied verbatim from
 * `results`; the provider runs no model and invents nothing.
 */

import { keyedFetch, type KeyedFetchConfig } from "../external-fetch.ts";
import { asText, type ProviderSearchResult, type ResearchProvider } from "./provider.ts";

/** Env var that gates the Tavily provider. */
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
/** Stable provider name used in pool reports. */
export const TAVILY_PROVIDER_NAME = "tavily";
/** Tavily search endpoint. A named constant; never logged with a key. */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

function parseResults(payload: unknown): ProviderSearchResult[] {
  if (payload === null || typeof payload !== "object") return [];
  const results = (payload as Record<string, unknown>)["results"];
  if (!Array.isArray(results)) return [];
  const out: ProviderSearchResult[] = [];
  for (const raw of results) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = asText(record["url"]);
    if (url.length === 0) continue;
    out.push({ title: asText(record["title"]), url, snippet: asText(record["content"]) });
  }
  return out;
}

export function createTavilyProvider(config: KeyedFetchConfig): ResearchProvider {
  return {
    name: TAVILY_PROVIDER_NAME,
    async search(query: string): Promise<readonly ProviderSearchResult[]> {
      const payload = await keyedFetch(config, {
        url: TAVILY_ENDPOINT,
        method: "POST",
        body: { query },
        auth: { scheme: "bearer" },
      });
      return parseResults(payload);
    },
  };
}
