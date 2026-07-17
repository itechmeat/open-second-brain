/**
 * Progressive disclosure (D1-D3): project a ranked result into a
 * token-cheap layer-1 card, and expand a card the agent already holds
 * into its fuller note (layer 2) and paginated raw chunks (layer 3).
 */

import { formatLinePointer } from "./line-numbering.ts";
import { Store } from "./store.ts";
import { SearchError } from "./types.ts";
import type {
  BrainSearchResult,
  ExpandHitInput,
  ExpandHitResult,
  ResolvedSearchConfig,
  SearchCard,
} from "./types.ts";

/** Max chars of a layer-1 card snippet — enough to judge a hit, cheap to carry. */
const CARD_SNIPPET_CHARS = 240;
/** Default layer-3 raw-chunk page size for `expandHit`. */
const DEFAULT_EXPAND_RAW_LIMIT = 10;

/**
 * Project a ranked result into a layer-1 card (progressive disclosure):
 * identity + score + the same `reasons`, a whitespace-collapsed snippet
 * capped at {@link CARD_SNIPPET_CHARS}, and a `path:Lstart-Lend` pointer
 * (D2 grammar) over the chunk's stored line span. No full content.
 */
export function toSearchCard(result: BrainSearchResult): SearchCard {
  return Object.freeze({
    chunkId: result.chunkId,
    documentId: result.documentId,
    path: result.path,
    title: result.title,
    score: result.score,
    reasons: result.reasons,
    snippet: cardSnippet(result.content),
    pointer: formatLinePointer(result.path, result.startLine, result.endLine),
    ...(result.origin !== undefined ? { origin: result.origin } : {}),
  });
}

export function cardSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  // Truncate on code points, not UTF-16 units: a raw `.slice` can cut an
  // astral character (emoji, rare CJK) mid-surrogate-pair, shipping a lone
  // surrogate that renders as U+FFFD. Spreading into an array iterates by
  // code point, so the cap never splits a character.
  const points = [...collapsed];
  return points.length <= CARD_SNIPPET_CHARS
    ? collapsed
    : `${points.slice(0, CARD_SNIPPET_CHARS).join("")}...`;
}

/**
 * Progressive disclosure (D3): layers 2 and 3 of a hit the agent already
 * holds as a layer-1 card. Given the card's `chunkId`, reconstruct the
 * fuller note (layer 2) from the document's stored chunks and return a
 * paginated slice of those raw chunks (layer 3), mirroring
 * `expandSessionRecall`'s cursor contract.
 *
 * Read-only by construction: it opens the index in read mode and never
 * self-heals — a card can only exist because a prior search built the
 * index, and a rebuild would WRITE it. The layer-2/3 data is pure store
 * reads (`hydrateChunks` + `getChunksByDocument`), never a new index.
 */
export async function expandHit(
  config: ResolvedSearchConfig,
  input: ExpandHitInput,
): Promise<ExpandHitResult> {
  if (!Number.isInteger(input.chunkId) || input.chunkId < 1) {
    throw new SearchError("INVALID_INPUT", "chunkId must be a positive integer");
  }
  const store = await Store.open(config, { mode: "read" });
  try {
    const hit = store.hydrateChunks([input.chunkId]).get(input.chunkId);
    if (hit === undefined) {
      throw new SearchError("INVALID_INPUT", `chunk not found: ${input.chunkId}`);
    }
    // Document chunks in `chunkIndex` order: the fuller note (layer 2) is
    // their concatenation; the raw transcript (layer 3) is the same rows.
    const chunks = store.getChunksByDocument(hit.documentId);
    const lineStart = chunks.length > 0 ? chunks[0]!.startLine : hit.startLine;
    const lineEnd = chunks.length > 0 ? chunks[chunks.length - 1]!.endLine : hit.endLine;
    const note = Object.freeze({
      documentId: hit.documentId,
      path: hit.path,
      title: hit.title,
      lineStart,
      lineEnd,
      pointer: formatLinePointer(hit.path, lineStart, lineEnd),
      content: chunks.map((c) => c.content).join("\n"),
    });

    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
    const rawLimit = Math.max(1, input.rawLimit ?? DEFAULT_EXPAND_RAW_LIMIT);
    const page = chunks.slice(offset, offset + rawLimit).map((c) =>
      Object.freeze({
        chunkId: c.id,
        chunkIndex: c.chunkIndex,
        startLine: c.startLine,
        endLine: c.endLine,
        pointer: formatLinePointer(hit.path, c.startLine, c.endLine),
        content: c.content,
      }),
    );
    const nextOffset = offset + rawLimit;
    return Object.freeze({
      chunkId: input.chunkId,
      note,
      raw_content: Object.freeze(page),
      next_cursor: nextOffset < chunks.length ? String(nextOffset) : null,
    });
  } finally {
    await store.close();
  }
}
