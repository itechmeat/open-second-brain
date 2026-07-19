/**
 * Full-page extract step (R1, t_1dcbf352).
 *
 * Fetches a page's text through the seam-2 keyed helper and reduces it to
 * bounded plain text. The output feeds the existing citation-constrained
 * pipeline via {@link findingFromExtract}: the finding statement is drawn ONLY
 * from the fetched text and cites the fetched URL, so the report never carries
 * invented content and the citation contract in research.ts still holds.
 *
 * The reduction is purely mechanical (drop script/style, strip tags, collapse
 * whitespace) - no natural-language word list, so it is script-agnostic.
 */

import { keyedFetch, type KeyedFetchConfig } from "./external-fetch.ts";
import type { ResearchFinding } from "./research.ts";

/** Upper bound on extracted text, so a page cannot bloat a report. */
export const EXTRACT_MAX_CHARS = 4000;
/** Upper bound on a single finding statement drawn from a page. */
export const FINDING_MAX_CHARS = 500;

export interface ExtractedPage {
  readonly url: string;
  readonly text: string;
}

const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

/** Reduce raw HTML to bounded plain text. Mechanical; no language assumptions. */
export function htmlToText(html: string, maxChars: number = EXTRACT_MAX_CHARS): string {
  const withoutScripts = html.replace(SCRIPT_STYLE_RE, " ");
  const withoutTags = withoutScripts.replace(TAG_RE, " ");
  const collapsed = withoutTags.replace(WHITESPACE_RE, " ").trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

/**
 * Fetch a page and return its bounded plain text. Any network or auth failure
 * surfaces as the typed {@link import("./external-fetch.ts").ExternalFetchError}
 * from the helper, for the caller to carry in a report.
 */
export async function extractPage(config: KeyedFetchConfig, url: string): Promise<ExtractedPage> {
  const raw = await keyedFetch(config, { url, accept: "text" });
  return { url, text: htmlToText(String(raw)) };
}

/**
 * Turn an extracted page into a finding for the citation-constrained pipeline.
 * The statement is a verbatim prefix of the fetched text (never invented) and
 * cites the fetched URL, so `writeResearchReport` accepts it only when the URL
 * is also in the consulted sources.
 */
export function findingFromExtract(
  page: ExtractedPage,
  maxChars: number = FINDING_MAX_CHARS,
): ResearchFinding {
  const statement = page.text.length > maxChars ? page.text.slice(0, maxChars) : page.text;
  return { statement, sources: [page.url] };
}
