/**
 * Canonical offset-cursor pagination for list surfaces.
 *
 * This is the single shared helper for the MCP list tools that page by
 * numeric offset: `encodeOffsetCursor`/`decodeOffsetCursor` are lifted
 * verbatim from the decisions history (`src/core/brain/decisions/receipts.ts`),
 * the oldest live encoding and the one already validated by malformed-cursor
 * tests, so every new cursor surface speaks one opaque form.
 *
 * Limitation, accepted by the decisions precedent: an offset cursor over a
 * mutable newest-first log can skip or repeat entries when records land
 * between pages. Cursors are opaque to callers and may be persisted
 * mid-walk, so existing encodings on decisions history, session expand,
 * search expand and continuity do not change - only new surfaces adopt
 * this helper.
 */

/** Longest cursor any schema advertises (base64url of `o:<offset>`). */
export const OFFSET_CURSOR_MAX_LENGTH = 32;

/** Error thrown for a malformed offset cursor. */
export class OffsetCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffsetCursorError";
  }
}

/** Encode a numeric offset as an opaque cursor. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

/** Decode an opaque cursor to its offset; rejects a malformed cursor. */
export function decodeOffsetCursor(cursor: string): number {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new OffsetCursorError("malformed cursor");
  }
  const m = /^o:(\d+)$/.exec(decoded);
  if (!m) throw new OffsetCursorError("malformed cursor");
  const offset = Number.parseInt(m[1]!, 10);
  if (offset < 0) throw new OffsetCursorError("malformed cursor");
  return offset;
}

export interface OffsetCursorPage<T> {
  /** The records on this page. */
  readonly items: ReadonlyArray<T>;
  /** Exact count of the full (unpaginated) set. */
  readonly total: number;
  /** Opaque cursor for the next page, or `null` when exhausted. */
  readonly next_cursor: string | null;
}

/**
 * Slice one page out of the full item list, computing the `next_cursor`
 * (`null` when exhausted). `total` defaults to `items.length`; pass it
 * explicitly where the caller's total is not the sliced array's length.
 */
export function pageSlice<T>(
  items: ReadonlyArray<T>,
  offset: number,
  limit: number,
  total: number = items.length,
): OffsetCursorPage<T> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new OffsetCursorError("limit must be a positive integer");
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const next_cursor = nextOffset < total ? encodeOffsetCursor(nextOffset) : null;
  return { items: page, total, next_cursor };
}
