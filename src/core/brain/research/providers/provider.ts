/**
 * Web-research provider contract (R1, t_1dcbf352).
 *
 * A provider turns a query string into a bounded list of external search
 * results through the seam-2 keyed fetch helper. It runs no model and invents
 * no content: every field is copied verbatim from the provider's response.
 * Providers are constructed only when their key env is set (see the pool
 * wiring in research.ts), so a keyless deployment holds no providers at all.
 */

/** One external search result, copied verbatim from a provider response. */
export interface ProviderSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** A web-research provider. Named for reporting; `search` is the only verb. */
export interface ResearchProvider {
  readonly name: string;
  search(query: string): Promise<readonly ProviderSearchResult[]>;
}

/** Coerce an unknown field to a trimmed string, or empty when absent. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
