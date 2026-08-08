/**
 * Progressive disclosure (D1-D3): project a ranked result into a
 * token-cheap layer-1 card, and expand a card the agent already holds
 * into its fuller note (layer 2) and paginated raw chunks (layer 3).
 */

import { normalizeAgentScope } from "../graph/agent-scope.ts";
import { formatLinePointer } from "./line-numbering.ts";
import { isPathOwnerVisible } from "./result-filters.ts";
import { markWindow, matchOffset, toCodePointOffset, windowStartWithin } from "./snippet-window.ts";
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
/**
 * Continuation marker for a card snippet that does not cover the whole
 * chunk. Three ASCII dots, not U+2026: the card grammar has shipped this
 * spelling since progressive disclosure landed, and the other preview
 * surfaces use the single-character form.
 */
const CARD_ELLIPSIS = "...";
/** Default layer-3 raw-chunk page size for `expandHit`. */
const DEFAULT_EXPAND_RAW_LIMIT = 10;

/**
 * The merged-away duplicate locations, as `path:Lstart-Lend` pointers.
 *
 * A card carries POINTERS rather than the full location records the
 * ranked row holds: the folded passage is byte-identical to the surviving
 * one by construction, so a caller never needs to expand a copy - it needs
 * to know where else the same bytes live, which is exactly what the card's
 * own `pointer` grammar says. That keeps the token-cheap layer cheap and
 * reuses the rendering the full transcript already uses.
 */
function duplicatePointers(result: BrainSearchResult): ReadonlyArray<string> {
  return Object.freeze(
    (result.duplicates ?? []).map((d) => formatLinePointer(d.path, d.startLine, d.endLine)),
  );
}

/**
 * Project a ranked result into a layer-1 card (progressive disclosure):
 * identity + score + the same `reasons`, a whitespace-collapsed snippet
 * capped at {@link CARD_SNIPPET_CHARS} and anchored on the query match,
 * and a `path:Lstart-Lend` pointer (D2 grammar) over the chunk's stored
 * line span. No full content.
 *
 * `query` is the residual query text the row was retrieved for; it
 * decides where the snippet window opens. It is required rather than
 * optional because a card whose snippet silently reverted to the head of
 * the chunk is the defect this signature exists to prevent.
 */
export function toSearchCard(result: BrainSearchResult, query: string): SearchCard {
  return Object.freeze({
    chunkId: result.chunkId,
    documentId: result.documentId,
    path: result.path,
    title: result.title,
    score: result.score,
    reasons: result.reasons,
    snippet: cardSnippet(result.content, query),
    pointer: formatLinePointer(result.path, result.startLine, result.endLine),
    ...(result.origin !== undefined ? { origin: result.origin } : {}),
    // Exact-duplicate merge (task D): the locations this row was folded
    // from, so cards mode reports them instead of silently dropping a
    // value the pipeline already computed. Absent, never null and never
    // empty, when nothing was merged.
    ...(result.duplicates !== undefined && result.duplicates.length > 0
      ? { duplicatePointers: duplicatePointers(result) }
      : {}),
  });
}

/**
 * The card snippet: whitespace-collapsed content, windowed on the first
 * significant `query` term it contains, capped at
 * {@link CARD_SNIPPET_CHARS} code points.
 *
 * `query` defaults to the empty string, which has no significant terms
 * and is therefore the defined no-match case — the head of the chunk,
 * byte-identical to the pre-anchoring snippet. That default exists for
 * callers that hold content without a query at all; the ranked path
 * always passes one through {@link toSearchCard}.
 *
 * The cap bounds the BODY; each {@link CARD_ELLIPSIS} sits outside it, so
 * a window cut at both ends reaches `CARD_SNIPPET_CHARS + 2 *
 * CARD_ELLIPSIS.length` code points. Shrinking the body to hold a fixed
 * total would make an anchored card show LESS evidence than a
 * head-anchored one, which is the opposite of what anchoring is for; the
 * markers are continuation decoration, not content.
 */
export function cardSnippet(content: string, query = ""): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  // Window and truncate on code points, not UTF-16 units: a raw `.slice`
  // can cut an astral character (emoji, rare CJK) mid-surrogate-pair,
  // shipping a lone surrogate that renders as U+FFFD. Spreading into an
  // array iterates by code point, so neither edge splits a character —
  // and an index into that array is always a code-point boundary, which
  // is why this surface needs no start alignment.
  const points = [...collapsed];
  const start = windowStartWithin(
    toCodePointOffset(collapsed, matchOffset(collapsed, query)),
    CARD_SNIPPET_CHARS,
    points.length,
  );
  const end = start + CARD_SNIPPET_CHARS;
  return markWindow(points.slice(start, end).join(""), start, end < points.length, CARD_ELLIPSIS);
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
 *
 * ## Ownership (context-integrity-gates, Unit A)
 *
 * `chunkId` is a SEQUENTIAL INTEGER, so without a check this is an
 * enumeration surface for whole note bodies: walking the integers
 * returns every document in the vault, ranking and query filters
 * bypassed entirely. Under an `agentScope` the resolved path's owner is
 * checked with the same {@link isPathOwnerVisible} rule the ranked filter
 * uses, and a refusal is {@link notFound} — byte-for-byte the error an
 * absent chunk produces. A distinguishable refusal would still leak: it
 * would confirm that the chunk exists and belongs to someone else,
 * which is exactly what enumeration is looking for.
 *
 * An omitted or blank scope filters nothing, so an unscoped call is
 * byte-identical.
 */
export async function expandHit(
  config: ResolvedSearchConfig,
  input: ExpandHitInput,
): Promise<ExpandHitResult> {
  if (!Number.isInteger(input.chunkId) || input.chunkId < 1) {
    throw new SearchError("INVALID_INPUT", "chunkId must be a positive integer");
  }
  const agentScope = normalizeAgentScope(input.agentScope);
  const store = await Store.open(config, { mode: "read" });
  try {
    const hit = store.hydrateChunks([input.chunkId]).get(input.chunkId);
    if (hit === undefined) {
      throw notFound(input.chunkId);
    }
    if (agentScope !== null && !ownerVisible(config, hit.path, agentScope)) {
      throw notFound(input.chunkId);
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

/**
 * The single construction of the drill-down's not-found error. Both the
 * absent-chunk branch and the ownership refusal call it, so the two
 * cannot drift into distinguishable messages.
 */
function notFound(chunkId: number): SearchError {
  return new SearchError("INVALID_INPUT", `chunk not found: ${chunkId}`);
}

/**
 * Is the note at `path` reachable under `scope`? Fails CLOSED on an
 * unreadable page, matching `applyAgentScope` on the ranked path: an
 * owner that cannot be determined is treated as somebody else's rather
 * than as shared.
 *
 * Delegates to {@link isPathOwnerVisible} rather than restating the rule,
 * so the drill-down and the ranked filter cannot drift on what "closed"
 * means — including the unreadable-file verdict, which an empty
 * frontmatter map cannot express.
 */
function ownerVisible(config: ResolvedSearchConfig, path: string, scope: string): boolean {
  // One hit, so the cache is a formality — it exists because the shared
  // reader takes one, and reusing it keeps this check on exactly the
  // same parse semantics as the ranked filter.
  return isPathOwnerVisible(config.vault, path, scope, new Map());
}
