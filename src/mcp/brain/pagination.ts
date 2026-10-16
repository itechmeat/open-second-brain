/**
 * MCP-side companion of the core offset-cursor helper
 * (src/core/brain/offset-cursor.ts): the input-schema shape every adopting
 * list tool declares, and the argument read that turns a cursor into its
 * offset with a malformed cursor refused as INVALID_PARAMS.
 *
 * The description ceiling and wording follow the brain_search_expand
 * precedent; the registry-guard audit fails on an undescribed property,
 * so the schema constant carries its description with it.
 */

import { OFFSET_CURSOR_MAX_LENGTH, decodeOffsetCursor } from "../../core/brain/offset-cursor.ts";
import { coerceStringOptional } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";

/** The `cursor` input property every offset-paginated tool declares. */
export const CURSOR_SCHEMA = {
  type: "string",
  maxLength: OFFSET_CURSOR_MAX_LENGTH,
  description: "Pagination cursor returned as next_cursor by a prior call.",
} as const;

/**
 * Read the `cursor` argument as its numeric offset (0 when absent). A
 * malformed cursor is a caller error, not a silent page restart.
 */
export function cursorOffsetArg(tool: string, args: Record<string, unknown>): number {
  const raw = coerceStringOptional(args, "cursor", OFFSET_CURSOR_MAX_LENGTH);
  if (raw === undefined) return 0;
  try {
    return decodeOffsetCursor(raw);
  } catch {
    throw new MCPError(INVALID_PARAMS, `${tool}: malformed cursor`);
  }
}
